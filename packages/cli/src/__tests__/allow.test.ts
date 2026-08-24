import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { allowCommand, isRuleOverridden } from '../commands/allow.js'
import { AuditLog } from '../core/enforce/audit.js'
import { DEFAULT_RULES_YAML } from '../commands/install.js'
import type { EnforceResult } from '../core/types.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * `keel allow <id> --session` — scopes an override to "the current agent
 * session" without ever running inside the agent's own process (this CLI
 * command is user-run, in a separate terminal, and is itself hard-blocked
 * for agents by `keel-control-gate`). "Current" is resolved from the most
 * recent session_id in the audit trail — the session that most recently
 * triggered enforcement activity is the one a human means when they say
 * "allow this for the session I'm looking at right now".
 *
 * Isolation: KEEL_OVERRIDES_DIR and KEEL_TRACES_DIR point at private temp
 * dirs so this suite never touches the real ~/.keel, and process.cwd() has
 * no .keel/rules.yaml so `knownRuleIds()` falls back to the built-in
 * default set — `no-force-push` is one of those defaults.
 */

const RULE_ID = 'no-force-push'

let overridesDir = ''
let tracesDir = ''
let cwd = ''
let previousOverridesDir: string | undefined
let previousTracesDir: string | undefined
let previousCwd: string

function overridesFile(): string {
  return join(overridesDir, 'overrides.json')
}

function readOverrides(): Record<string, { expires_at: number; mode?: string; session_id?: string }> {
  return JSON.parse(readFileSync(overridesFile(), 'utf-8'))
}

/** Writes one audit entry with the given session_id, dated `msAgo` before now. */
function recordAuditActivity(sessionId: string, msAgo: number) {
  const auditLog = new AuditLog(tracesDir)
  const result: EnforceResult = {
    action: 'warn',
    rule_id: RULE_ID,
    rule_name: RULE_ID,
    message: 'First violation — warning only.',
    timestamp: new Date(Date.now() - msAgo).toISOString(),
  } as EnforceResult
  auditLog.record(result, {
    session_id: sessionId,
    turn_number: 1,
    tool: 'bash',
    args: { command: 'git push --force origin main' },
    level: 'balanced',
    context: 'local',
    agent: 'test',
    subagent_of: null,
    context_tokens: 0,
  })
}

let logSpy: string[] = []
let originalLog: typeof console.log

beforeEach(() => {
  overridesDir = mkdtempSync(join(tmpdir(), 'keel-allow-overrides-'))
  tracesDir = mkdtempSync(join(tmpdir(), 'keel-allow-traces-'))
  cwd = mkdtempSync(join(tmpdir(), 'keel-allow-cwd-'))
  previousOverridesDir = process.env.KEEL_OVERRIDES_DIR
  previousTracesDir = process.env.KEEL_TRACES_DIR
  previousCwd = process.cwd()
  process.env.KEEL_OVERRIDES_DIR = overridesDir
  process.env.KEEL_TRACES_DIR = tracesDir
  process.chdir(cwd)
  logSpy = []
  originalLog = console.log
  console.log = (...args: unknown[]) => { logSpy.push(args.join(' ')) }
})

afterEach(() => {
  console.log = originalLog
  process.chdir(previousCwd)
  if (previousOverridesDir === undefined) delete process.env.KEEL_OVERRIDES_DIR
  else process.env.KEEL_OVERRIDES_DIR = previousOverridesDir
  if (previousTracesDir === undefined) delete process.env.KEEL_TRACES_DIR
  else process.env.KEEL_TRACES_DIR = previousTracesDir
  process.exitCode = 0
  rmSafe(overridesDir)
  rmSafe(tracesDir)
  rmSafe(cwd)
})

describe('keel allow --session', () => {
  it('refuses to scope to a session when there is no enforcement activity yet', async () => {
    await allowCommand(RULE_ID, { session: true })
    expect(process.exitCode).toBe(1)
    expect(existsSync(overridesFile())).toBe(false)
    expect(logSpy.join('\n')).toContain('No recent enforcement activity')
  })

  it('resolves "current session" as the MOST RECENT session_id, not just any session_id', async () => {
    recordAuditActivity('ses_older', 60000)   // 1 minute ago
    recordAuditActivity('ses_newer', 1000)    // 1 second ago

    await allowCommand(RULE_ID, { session: true })
    expect(process.exitCode).not.toBe(1)

    const overrides = readOverrides()
    expect(overrides[RULE_ID].mode).toBe('session')
    expect(overrides[RULE_ID].session_id).toBe('ses_newer')
    // Bounded, not forever — a 24h ceiling in case that session never ends.
    expect(overrides[RULE_ID].expires_at).toBeGreaterThan(Date.now())
    expect(overrides[RULE_ID].expires_at).toBeLessThanOrEqual(Date.now() + 86400000 + 5000)
  })

  it('writes into KEEL_OVERRIDES_DIR, not the real ~/.keel — reader/writer split closed', async () => {
    recordAuditActivity('ses_a', 0)
    await allowCommand(RULE_ID, { session: true })
    expect(existsSync(overridesFile())).toBe(true)
  })

  it('rejects --once and --session together rather than picking one silently', async () => {
    recordAuditActivity('ses_a', 0)
    await allowCommand(RULE_ID, { once: true, session: true })
    expect(process.exitCode).toBe(1)
    expect(existsSync(overridesFile())).toBe(false)
    expect(logSpy.join('\n')).toContain('one of --once or --session')
  })

  it('--session <id> pins an explicit session_id instead of auto-resolving, for when multiple sessions are live', async () => {
    // No audit activity recorded at all — proves this path never consults
    // resolveCurrentSessionId(), unlike bare --session.
    await allowCommand(RULE_ID, { session: 'ses_pinned_explicitly' })
    expect(process.exitCode).not.toBe(1)
    const overrides = readOverrides()
    expect(overrides[RULE_ID].mode).toBe('session')
    expect(overrides[RULE_ID].session_id).toBe('ses_pinned_explicitly')
  })

  it('warns when the auto-resolved session_id has the per-process-fallback shape (grant may never match again)', async () => {
    // Exactly the shape enforce.ts's initEnforce() mints when a host
    // supplies no session_id of its own.
    recordAuditActivity('ses_1a2b3c_x7y8z9', 0)
    await allowCommand(RULE_ID, { session: true })
    expect(logSpy.join('\n')).toContain('per-process fallback id')
  })

  it('does NOT warn about the fallback shape for an explicitly pinned --session <id>, and does not warn for a real-looking id', async () => {
    await allowCommand(RULE_ID, { session: 'ses_1a2b3c_x7y8z9' })
    expect(logSpy.join('\n')).not.toContain('per-process fallback id')

    logSpy = []
    recordAuditActivity('a1b2c3d4-e5f6-7890-uuid-looking-id', 0)
    await allowCommand(RULE_ID, { session: true })
    expect(logSpy.join('\n')).not.toContain('per-process fallback id')
  })

  it('rejects an unknown rule id before ever touching the audit trail or overrides file', async () => {
    recordAuditActivity('ses_a', 0)
    await allowCommand('not-a-real-rule-id', { session: true })
    expect(process.exitCode).toBe(1)
    expect(existsSync(overridesFile())).toBe(false)
  })

  it('--once is unchanged: 5-minute single-use window, mode "once"', async () => {
    await allowCommand(RULE_ID, { once: true })
    const overrides = readOverrides()
    expect(overrides[RULE_ID].mode).toBe('once')
    expect(overrides[RULE_ID].expires_at).toBeLessThanOrEqual(Date.now() + 300000 + 5000)
  })

  it('no flags: unchanged 24h "window" form, mode "window"', async () => {
    await allowCommand(RULE_ID, {})
    const overrides = readOverrides()
    expect(overrides[RULE_ID].mode).toBe('window')
    expect(overrides[RULE_ID].session_id).toBeUndefined()
  })

  it('isRuleOverridden reports a live session override as active, honoring KEEL_OVERRIDES_DIR', async () => {
    recordAuditActivity('ses_a', 0)
    expect(isRuleOverridden(RULE_ID)).toBe(false)
    await allowCommand(RULE_ID, { session: true })
    expect(isRuleOverridden(RULE_ID)).toBe(true)
  })

  it('`keel allow <id> --session` still matches the agent-blocking keel-control-gate pattern', () => {
    // keel-control-gate must not need a bespoke update per new `keel allow`
    // flag — it matches on the subcommand, not its options. Regression
    // check against the actual shipped pattern rather than a paraphrase.
    const match = DEFAULT_RULES_YAML.match(/id: keel-control-gate[\s\S]*?match: "([^"]+)"/)
    expect(match).not.toBeNull()
    const pattern = new RegExp(match![1])
    expect(pattern.test(`keel allow ${RULE_ID} --session`)).toBe(true)
    expect(pattern.test(`keel allow ${RULE_ID} --once`)).toBe(true)
  })
})
