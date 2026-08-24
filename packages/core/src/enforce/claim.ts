import type { EnforceInput } from '../types.js'
import { commandString } from './arg-utils.js'

/**
 * Claim-to-evidence grammar (Wave-2 Lane-3).
 *
 * False-success research (see session/EVIDENCE/wave2-claim.md) found 75.8%
 * of failing coding-agent trajectories carried an explicit false success
 * claim, and that LLM judges score ~0.54 AUROC at spotting them — near
 * chance. This module is the deterministic alternative: it does not
 * "understand" whether a claim is true, it only extracts CLAIM-SHAPED text
 * (a completion/verification assertion) so the caller (pipeline.ts) can
 * cross-reference it against whether a verification obligation is still
 * pending (see verification.ts / claim rule wiring in pipeline.ts).
 *
 * ── Where the text comes from ──
 *
 * `EnforceInput.reasoning` is the field designed to carry the agent's own
 * words, but a survey of every host wired into `keel hook <host>`
 * (packages/cli/src/commands/hook.ts:parsePayload) found NONE of them
 * populate it: Claude Code, Gemini, and Codex hand over only
 * `{tool_name, tool_input}` via env vars; Cline and Cursor's payloads carry
 * no free-text field either. The OpenCode plugin conditionally forwards
 * `hookInput.reasoning` (plugin.ts:339), but OpenCode's documented
 * `tool.execute.before(input, output)` hook shape is `{sessionID, callID,
 * tool}` / `{args}` — no chain-of-thought field — so in practice that
 * branch is speculative and very likely always undefined too.
 *
 * The one channel that DOES reliably carry the agent's own natural-language
 * assertion through every host today is a command argument the agent
 * writes itself: `git commit -m "..."`, `gh pr create --body "..."`. That
 * is why `extractCommandMessages` below is the PRIMARY surface in
 * production, not a fallback — `input.reasoning` is scanned too, ready for
 * the day a host wires it up, but is exercised by tests only.
 *
 * ── Claim grammar ──
 *
 * Deliberately narrow: a regex heuristic, not a parser. It requires a
 * completion/verification word in a claim-SHAPED clause (subject +
 * linking verb, or a clause-leading past-participle), not a bare keyword
 * match — `git commit -m "fix: typo"` must not fire just because a
 * substring of "fixed" is nearby; "fix:" never matches `\bfixed\b`.
 *
 * ── Exclusions (position-awareness) ──
 *   - fenced/inline code and URLs/paths are stripped before scanning — a
 *     claim word inside a code sample or a file path is not an assertion.
 *   - quoted spans inside free-form `reasoning` text are stripped — that is
 *     reported speech (an error message, a log line, a user's words), not
 *     the agent's own claim. NOT applied to `extractCommandMessages` output:
 *     there the quotes are shell syntax bounding the argument, not
 *     reported speech, so the content inside is exactly what is scanned.
 *   - a hedge/negation word anywhere in the same utterance ("wip", "todo",
 *     "not run", "partial") suppresses the whole utterance.
 *
 * ── Known misses (documented honestly, not fixed) ──
 *   - no coreference: "I fixed the OTHER bug, this one's still broken" can
 *     still fire on "fixed" — the grammar has no clause-scoping beyond a
 *     single sentence-ish boundary.
 *   - no sarcasm/negation-at-a-distance ("yeah right, all tests 'pass'")
 *     unless the hedge word set happens to catch it.
 *   - only 4 message-carrying flags are recognized (-m/--message/--body/
 *     --title); a claim inside a `gh issue create --body-file` payload or a
 *     multi-line heredoc commit message is invisible to this grammar.
 *   - English only.
 */

const CODE_FENCE_RE = /```[\s\S]*?```/g
const INLINE_CODE_RE = /`[^`\n]*`/g
const URL_RE = /\bhttps?:\/\/\S+/gi
// A path-shaped token: at least one `/` between word-ish segments. Strips
// both real file paths ("src/tests-fixed/report.ts") and URLs missed above.
const PATH_RE = /\b(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\b/g

function stripNoise(text: string): string {
  return text
    .replace(CODE_FENCE_RE, ' ')
    .replace(INLINE_CODE_RE, ' ')
    .replace(URL_RE, ' ')
    .replace(PATH_RE, ' ')
}

// Quoted spans in free-form reasoning are reported speech, not an
// assertion by the speaker — "the error said \"tests passing\" but it
// actually failed" must not fire. Straight and curly quotes both handled.
const QUOTED_RE = /"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’/g
function stripQuoted(text: string): string {
  return text.replace(QUOTED_RE, ' ')
}

// Anywhere in the same utterance, a hedge/negation marker means a nearby
// completion word is NOT a claim: "tests not run yet", "wip", "partial".
const HEDGE_RE = /\b(wip|w\.i\.p\.|draft|todo|to-do|partial|pending|incomplete|in[- ]progress|not\s+(?:yet\s+)?(?:run|ran|tested|verified|complete[d]?|done|passing|working)|no\s+tests?|untested|unverified|not\s+sure|might|maybe|probably|should\s+(?:now\s+)?(?:be|pass)|still\s+(?:need|broken|failing))\b/i

// Claim shapes. Each entry is a distinct grammatical pattern, not a keyword
// list — see the module doc for why bare keywords are the wrong surface.
const CLAIM_PATTERNS: { name: string; re: RegExp }[] = [
  // "all tests pass", "the test suite is passing", "tests succeeded"
  { name: 'tests-pass', re: /\b(?:all |the )?tests?(?:\s+suite)?\s+(?:(?:is|are|now)\s+)?(?:pass(?:ed|ing)?|green|succeed(?:ed|s)?)\b/i },
  // "build is passing/green/successful/clean"
  { name: 'build-pass', re: /\bbuild\s+(?:is\s+)?(?:passing|green|successful|clean)\b/i },
  // "verification passed/complete"
  { name: 'verification-noun', re: /\bverification\s+(?:passed|complete[d]?)\b/i },
  // "this/it/the fix is done/fixed/complete/tested/verified/working/resolved/ready"
  { name: 'linking-verb', re: /\b(?:this|that|it|everything|the\s+(?:fix|bug|issue|feature|change|pr))\s+(?:is|are|was|now)\s+(?:done|complete[d]?|fixed|tested|verified|working|resolved|ready)\b/i },
  // clause-leading past-participle claim: "Fixed and passing.", "Done."
  // The negative lookahead excludes a conventional-commit-style label
  // ("fixed:" as a header) from being read as an assertion.
  { name: 'clause-leading', re: /(?:^|[.!;]\s+|,\s*(?:and\s+)?|\band\s+)(done|fixed|complete[d]?|tested|verified|resolved)\b(?!\s*[:\-])/i },
  // bare "verified" is a rarer, stronger signal than "done"/"fixed" — kept
  // as its own pattern so it does not need clause-leading position.
  { name: 'verified-explicit', re: /\bverified\b(?!\s*[:\-])/i },
]

export interface ClaimMatch {
  /** The matched text, trimmed. */
  phrase: string
  /** Which CLAIM_PATTERNS entry matched — for messages/debugging. */
  pattern: string
  /** Which channel the claim text came from. */
  source: 'reasoning' | 'command-message'
}

function scanUtterance(raw: string, source: ClaimMatch['source']): ClaimMatch | null {
  if (!raw) return null
  let text = stripNoise(raw)
  if (source === 'reasoning') text = stripQuoted(text)
  if (HEDGE_RE.test(text)) return null
  for (const { name, re } of CLAIM_PATTERNS) {
    const m = re.exec(text)
    if (m) return { phrase: m[0].trim(), pattern: name, source }
  }
  return null
}

// -m / --message / --body / --title, quoted (straight quotes; `=` form too:
// --message="...").  The quotes here are shell argument delimiters, not
// reported speech, so the captured value is scanned as-is (no stripQuoted).
const MESSAGE_FLAG_RE = /(?:-m|--message|--body|--title)[\s=]+(?:"([^"]*)"|'([^']*)')/g

/** Extract commit/PR/issue message-argument VALUES from a command string. */
export function extractCommandMessages(cmd: string): string[] {
  const out: string[] = []
  const re = new RegExp(MESSAGE_FLAG_RE)
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) {
    const value = m[1] ?? m[2] ?? ''
    if (value) out.push(value)
  }
  return out
}

/**
 * Detect a false-success-shaped claim in an action's visible text.
 * Checked, in order: `input.reasoning` (see module doc — untested channel
 * in production today), then any commit/PR/issue message the command
 * itself carries (the channel that is actually wired up).
 */
export function detectClaim(input: EnforceInput): ClaimMatch | null {
  if (input.reasoning) {
    const hit = scanUtterance(input.reasoning, 'reasoning')
    if (hit) return hit
  }
  const cmd = commandString(input)
  for (const message of extractCommandMessages(cmd)) {
    const hit = scanUtterance(message, 'command-message')
    if (hit) return hit
  }
  return null
}
