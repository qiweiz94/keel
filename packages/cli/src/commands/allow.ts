import chalk from 'chalk'
import { loadRuleHierarchy, parseRulesContent, validateRules } from '../core/enforce/rule-parser.js'
import { FileRuleOverrideStore } from '../core/enforce/overrides.js'
import { AuditLog } from '../core/enforce/audit.js'

// A fresh FileRuleOverrideStore per call, not a module-level singleton: a
// module-level const is fixed at first import, which is exactly the class
// of bug this repo has already hit and fixed elsewhere (KEEL_TRACES_DIR/
// KEEL_OVERRIDES_DIR in audit.ts and overrides.ts's own construction site
// — see their comments) — a test or isolated run that sets
// KEEL_OVERRIDES_DIR AFTER this module is first imported would otherwise
// still see the stale real path. FileRuleOverrideStore's own constructor
// already re-reads KEEL_OVERRIDES_DIR (falling back to resolveHome()) on
// every `new`, so constructing fresh here is enough — no separate
// directory-resolution helper needed.
//
// Routing through FileRuleOverrideStore (rather than allowCommand/
// isRuleOverridden hand-rolling their own read-modify-write of
// overrides.json) closes two things at once: this was previously the
// ONLY writer of overrides.json that did NOT go through the shared
// locked store, a real lost-update race against FileRuleOverrideStore.
// consume() (the enforcement pipeline's reader/consumer, running
// concurrently in a hook invocation) or a second `keel allow` call; and
// it crashed outright on a valid-but-wrong-shaped overrides.json (bare
// `null`, same class of bug as StateManager.loadFile — FileRuleOverride
// Store.read() already guards against that, allowCommand's own inline
// `JSON.parse` + assignment did not).
//
// This also keeps the reader/writer split closed: FileRuleOverrideStore
// (the enforcement pipeline's default overrideStore, consulted by `keel
// hook <host>` and friends) already honors KEEL_OVERRIDES_DIR, and now
// `keel allow` — the only thing that ever WRITES overrides.json — goes
// through the exact same construction path, so an isolated/test
// environment with KEEL_OVERRIDES_DIR set can never arm an override the
// pipeline's store fails to see (or vice versa).

// Same ceiling as the `--once`-less "window" form: a session override is
// bounded by session_id matching (see resolveCurrentSessionId below), but a
// TTL still keeps a session that's simply never revisited from sitting in
// overrides.json forever.
const SESSION_TTL_MS = 86400000  // 24 hours

// The exact shape `initEnforce()` (packages/cli/src/commands/enforce.ts)
// mints when a host supplies no session id of its own: `ses_` + a base36
// timestamp + `_` + 6 base36 chars. A resolved "current session" matching
// this pattern is a single ephemeral CLI subprocess's own fallback id, not
// a real host session — the NEXT call from that same host mints a brand
// new one, so a `--session` grant scoped to it can never match again. Real
// host session ids (Claude Code/Cursor UUIDs, etc.) don't collide with
// this pattern in practice.
const PER_PROCESS_FALLBACK_SESSION_ID = /^ses_[0-9a-z]+_[0-9a-z]{6}$/

/**
 * `keel allow <rule-id>` — override a blocked action.
 *
 *   keel allow <id> --once          — the NEXT violation is allowed (single use)
 *   keel allow <id> --session       — ALL violations allowed, but ONLY for calls
 *                                      carrying the same session_id as the most
 *                                      recent enforcement activity (see below) —
 *                                      until that session ends or 24h, whichever
 *                                      comes first. Never leaks to another
 *                                      session_id, even one running concurrently.
 *   keel allow <id> --session <id>  — same, but scoped to an EXPLICIT session_id
 *                                      instead of the auto-resolved most-recent
 *                                      one. Use this when more than one agent
 *                                      session is active at once — auto-resolving
 *                                      "the current session" from the audit trail
 *                                      is ambiguous the moment two are running in
 *                                      parallel, and this sidesteps that instead
 *                                      of guessing.
 *   keel allow <id>                 — ALL violations allowed for 24 hours (window)
 *
 * The user owns the control surface: agents are hard-blocked from running
 * this command by the `keel-control-gate` rule.
 */
export async function allowCommand(ruleId: string, options: { once?: boolean; session?: boolean | string }) {
  const known = await knownRuleIds()
  if (!known.includes(ruleId)) {
    console.log(chalk.red(`  Unknown rule id: "${ruleId}"`))
    console.log(chalk.yellow(`  Known rule ids: ${known.length ? known.join(', ') : '(none — no rules loaded)'}`))
    console.log(chalk.dim('  Run `keel validate` or `keel status` to see the active rules.'))
    process.exitCode = 1
    return
  }

  if (options.once && options.session) {
    console.log(chalk.red('  Use one of --once or --session, not both.'))
    process.exitCode = 1
    return
  }

  let sessionId: string | undefined
  if (options.session) {
    // `--session <id>` (an explicit string) pins it directly; bare
    // `--session` (boolean true from commander's optional-value option)
    // auto-resolves from the audit trail.
    sessionId = typeof options.session === 'string' ? options.session : resolveCurrentSessionId()
    if (!sessionId) {
      console.log(chalk.red('  No recent enforcement activity found, so there is no "current session" to scope this to.'))
      console.log(chalk.dim('  `keel allow --session` reads the most recent session_id out of the audit trail'))
      console.log(chalk.dim('  (~/.keel/traces, or $KEEL_TRACES_DIR) — trigger at least one tool call through'))
      console.log(chalk.dim('  the agent first, use `keel allow <id> --session <exact-session-id>` if you already'))
      console.log(chalk.dim('  know it, or use `keel allow <id> --once` / the default 24h window instead.'))
      process.exitCode = 1
      return
    }
  }

  const expiresAt = options.once
    ? Date.now() + 300000  // 5 minutes for --once
    : options.session
      ? Date.now() + SESSION_TTL_MS
      : Date.now() + 86400000  // 24 hours for the window form

  new FileRuleOverrideStore().grant(ruleId, {
    expires_at: expiresAt,
    ...(options.once ? { mode: 'once' as const } : options.session ? { mode: 'session' as const, session_id: sessionId } : { mode: 'window' as const }),
  })

  if (options.session) {
    console.log(chalk.green(`\n  ✓ Rule "${ruleId}" overridden for the current session (${sessionId})\n`))
    console.log(chalk.dim('  All violations of this rule are allowed for that session only — it will'))
    console.log(chalk.dim('  not apply to any other session, and expires in 24h if that session never ends.\n'))
    if (typeof options.session !== 'string' && sessionId && PER_PROCESS_FALLBACK_SESSION_ID.test(sessionId)) {
      // Honest, not silent: this id has the shape enforce.ts mints when a
      // host supplies none of its own — a fresh one every subprocess call
      // — so this grant may never be seen again by the same host. Do not
      // fail the command over it (the write already succeeded and is
      // harmless), but say so.
      console.log(chalk.yellow(`  ⚠ "${sessionId}" looks like a per-process fallback id, not a real host session_id.`))
      console.log(chalk.dim('    That host (e.g. Cline, or any --session id extraction this build has not'))
      console.log(chalk.dim('    confirmed — see session/EVIDENCE/wave3-warnsurface.md) may mint a NEW random'))
      console.log(chalk.dim('    id on its next call, in which case this grant will never match again.\n'))
    }
    return
  }

  const duration = options.once ? '5 minutes' : '24 hours'
  console.log(chalk.green(`\n  ✓ Rule "${ruleId}" overridden for ${duration}\n`))
  console.log(chalk.dim(options.once
    ? '  The next violation of this rule will be allowed.\n'
    : '  All violations of this rule are allowed until it expires.\n'))
}

/**
 * "The current session" for a CLI process that is never the agent's own
 * process — this runs in a human's separate terminal, so there is no live
 * session_id to read off a call in flight. The best available proxy is
 * whichever session_id the enforcement pipeline last actually saw, which is
 * exactly what a human running `keel allow foo --session` right after
 * watching their agent get warned means by "this session": the one that
 * just triggered the warning.
 */
function resolveCurrentSessionId(): string | undefined {
  const entries = new AuditLog().loadAll().filter(e => e.session_id)
  if (!entries.length) return undefined
  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
  return entries[0].session_id
}

/**
 * Collect every rule id keel knows about — the merged hierarchy plus the
 * built-in default set the plugin falls back to when no rules exist.
 */
async function knownRuleIds(): Promise<string[]> {
  const ids = new Set<string>()
  try {
    const hierarchy = loadRuleHierarchy(process.cwd())
    for (const scope of [hierarchy.global, hierarchy.user, hierarchy.project, hierarchy.local]) {
      if (scope?.rules) for (const rule of scope.rules) if (rule.id) ids.add(rule.id)
    }
  } catch { /* fall through to defaults */ }
  try {
    const { DEFAULT_RULES_YAML } = await import('./install.js')
    const defaults = parseRulesContent(DEFAULT_RULES_YAML, 'keel:defaults')
    if (!(defaults.errors || []).length) {
      for (const rule of defaults.rules) if (rule.id) ids.add(rule.id)
    }
  } catch { /* defaults unavailable — hierarchy ids only */ }
  return [...ids]
}

/**
 * Check if a rule is overridden (used by `keel status`). A fresh store
 * per call for the same per-call-env-read reason as the constructor
 * comment above. Routed through `peek()` (non-destructive) rather than
 * hand-rolling its own read: an expired entry is simply reported as "not
 * overridden" here and left for the next real `consume()` (or `keel
 * allow`) to clean up from disk — this function is a read-only status
 * check, not a writer, so it no longer needs its own locked
 * read-modify-write to prune it eagerly.
 */
export function isRuleOverridden(ruleId: string): boolean {
  return new FileRuleOverrideStore().peek(ruleId) !== null
}

export const overrideStoreForStatus = new FileRuleOverrideStore()
