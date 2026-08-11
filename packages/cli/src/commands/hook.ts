import { initEnforce, evaluateToolCall, evaluateClaimText } from './enforce.js'
import { BLOCKING_ACTIONS } from './evaluate.js'
import type { EnforceResult, ProtectionLevel } from '../core/types.js'

/**
 * `keel hook <host>` — one enforcement entry point for every agent host.
 *
 * This replaced four near-identical shell scripts that each parsed a JSON
 * payload from stdin, shelled out to `keel evaluate`, and pulled the
 * verdict back out of its JSON with sed. That last part could not survive
 * a rule message containing a quote:
 *
 *   intended : Keel blocked this action: Use "--force-with-lease" instead
 *   actual   : Keel blocked this action: Use \
 *
 * The output stayed valid JSON, so nothing errored and no test failed —
 * the user was told they were blocked with the reason truncated at the
 * first quote. The reason is the entire point of a block. sed is simply
 * the wrong tool for JSON, and no amount of patching four copies fixes
 * that.
 *
 * Doing it here also removes a process: a hook used to spawn `sh` AND a
 * second `keel`, per tool call. Now the host spawns one.
 *
 * Adding a host is an entry in HOSTS plus a parse/render branch, not a new script.
 */

export const HOSTS = ['claude-code', 'cline', 'cursor', 'codex', 'gemini', 'generic'] as const
export type Host = (typeof HOSTS)[number]

export interface ParsedCall {
  tool: string
  args: Record<string, unknown>
  /**
   * The host's own session/conversation id, when its payload carries one.
   * Confidence varies by host (see parsePayload): claude-code/codex/gemini
   * (`session_id`) and cursor (`conversation_id`) are confirmed against
   * each host's current published schema; cline's field name is a
   * best-effort guess (docs/integrations.md rates cline "types", not
   * verified for this field specifically) — see
   * session/EVIDENCE/wave3-warnsurface.md. Absent when unconfirmed or
   * genuinely not sent, which is honest: a call with no session_id simply
   * cannot participate in a `keel allow --session` grant.
   */
  sessionId?: string
  /**
   * The agent's own completed-turn text, when this payload is a claim-
   * reach event rather than a pre-tool-call one (v0.4 Phase 1). Set ONLY
   * for a Claude Code `Stop` hook payload today (`hook_event_name ===
   * 'Stop'`, carrying `last_assistant_message` — confirmed via
   * code.claude.com/docs/en/hooks and the CHANGELOG entry cited in
   * anthropics/claude-code#61152, "docs" confidence: not yet exercised
   * against a live Claude Code session, see session/v04/EVIDENCE/
   * phase-1.md). When set, `hookCommand` below routes to the claim-only
   * evaluator instead of a tool-call verdict — see its own comment for why
   * that must stay a structurally-can't-block path.
   *
   * Codex CLI documents the IDENTICAL `Stop`/`last_assistant_message`
   * shape (developers.openai.com/codex/hooks) but is deliberately NOT
   * wired here this phase — same citation tier, just out of this phase's
   * verified scope (see phase-1.md's host matrix).
   */
  reasoning?: string
}

/** What the host must do, expressed uniformly so tests can assert it. */
export interface HostVerdict {
  blocked: boolean
  exitCode: number
  stdout: string
  stderr: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read a host's payload. Malformed input degrades to an unknown tool
 * rather than throwing: a hook that crashes is a hook the host skips, and
 * every host surveyed treats a skipped hook as permission to proceed.
 */
export function parsePayload(host: Host, raw: string): ParsedCall {
  let body: Record<string, unknown>
  try {
    body = asRecord(JSON.parse(raw))
  } catch {
    return { tool: 'unknown', args: {} }
  }

  switch (host) {
    case 'cline': {
      const pre = asRecord(body.preToolUse)
      return {
        tool: typeof pre.toolName === 'string' ? pre.toolName : 'unknown',
        args: asRecord(pre.parameters),
        // No published or installed-type source confirms cline's session
        // field name (docs/integrations.md rates cline "types", but that
        // covers the toolName/parameters shape actually exercised, not a
        // session id) — try both the nested and top-level spellings a
        // preToolUse-shaped payload might plausibly use, and simply carry
        // none when neither is present rather than guess further.
        sessionId: stringField(pre.sessionId) || stringField(pre.session_id)
          || stringField(body.sessionId) || stringField(body.session_id),
      }
    }
    case 'cursor': {
      // Cursor sends a bare `command` for shell execution, or
      // tool_name/tool_input for an MCP call. `conversation_id` is part of
      // the common base schema shared by every Cursor hook event, sitting
      // alongside either shape (cursor.com/docs/hooks).
      const sessionId = stringField(body.conversation_id)
      if (typeof body.command === 'string') {
        return { tool: 'bash', args: { command: body.command }, sessionId }
      }
      return {
        tool: typeof body.tool_name === 'string' ? body.tool_name : 'unknown',
        args: asRecord(body.tool_input),
        sessionId,
      }
    }
    case 'claude-code': {
      // A Stop-shaped payload (`hook_event_name: "Stop"`) carries no
      // tool_name at all — it fires once per assistant turn, after the
      // model finishes, not before a tool call. `last_assistant_message`
      // is the agent's own completed text for that turn (v0.4 Phase 1's
      // claim-to-evidence channel — see ParsedCall.reasoning's comment for
      // the citations). Checked by hook_event_name specifically, not by
      // absence of tool_name, so a malformed/truncated PreToolUse payload
      // never gets misread as a Stop event.
      if (body.hook_event_name === 'Stop' && typeof body.last_assistant_message === 'string') {
        return {
          tool: 'assistant-message',
          args: {},
          sessionId: stringField(body.session_id),
          reasoning: body.last_assistant_message,
        }
      }
      return {
        tool: typeof body.tool_name === 'string' ? body.tool_name : 'unknown',
        args: asRecord(body.tool_input),
        sessionId: stringField(body.session_id),
      }
    }
    case 'codex':
    case 'gemini': {
      // Gemini CLI ships `gemini hooks migrate --from-claude`, which
      // advertises equivalence with the Claude Code hook format, so it
      // reads the same payload rather than a guessed one of its own.
      // `session_id` is on the base PreToolUse schema for both Claude Code
      // (code.claude.com/docs/en/hooks) and Codex (which converged on the
      // same hookSpecificOutput-shaped hook contract). Neither host's Stop
      // shape is wired here (see ParsedCall.reasoning's comment) — this
      // branch stays PreToolUse-only for both.
      return {
        tool: typeof body.tool_name === 'string' ? body.tool_name : 'unknown',
        args: asRecord(body.tool_input),
        sessionId: stringField(body.session_id),
      }
    }
    case 'generic':
    default: {
      return {
        tool: typeof body.tool === 'string' ? body.tool : 'unknown',
        args: asRecord(body.args),
        sessionId: stringField(body.session_id),
      }
    }
  }
}

function label(result: EnforceResult): string {
  const rule = result.rule_id ? `:${result.rule_id}` : ''
  const prefix = result.action === 'prompt'
    ? 'Keel requires approval'
    : result.action === 'redirect' || result.action === 'research'
      ? 'Keel redirected this action'
      : 'Keel blocked this action'
  return `${prefix} [keel${rule}]: ${result.message || 'rule violation'}`
}

const COULD_NOT_EVALUATE =
  'Keel could not evaluate this action, so it was blocked. '
  + "Check `keel validate` and ~/.keel/rules.yaml."

/**
 * Turn a verdict into what the host understands.
 *
 * `result === null` means keel itself failed. That blocks: a guardrail
 * that waves calls through when it breaks is worse than none, because it
 * is believed.
 */
export function renderVerdict(host: Host, result: EnforceResult | null): HostVerdict {
  const blocked = result === null || BLOCKING_ACTIONS.has(result.action)
  const text = result === null ? COULD_NOT_EVALUATE : label(result)

  if (!blocked) {
    // Advisory verdicts still reach the human — keel's ladder is
    // warn-once-then-block, so the first violation of every deny rule
    // arrives as `warn`, and swallowing it means no warning is ever seen.
    //
    // Putting this text on stderr with exit 0 is what every one of these
    // hosts was doing before this lane, and for the exit-code hosts it is
    // provably invisible: Claude Code's own hook docs (code.claude.com/
    // docs/en/hooks, fetched 2026-08-11) are explicit that stderr on exit 0
    // "goes to the debug log only, never shown to Claude or in transcript"
    // — an allow-with-warning that nobody sees is functionally identical
    // to no warning at all (warning-fatigue research: the human/model has
    // to actually see it to act on it). Each branch below uses that same
    // host's REAL non-blocking visible-message channel instead. See
    // session/EVIDENCE/wave3-warnsurface.md for the full before/after
    // matrix and the confidence level behind each one.
    const advisory = result && result.rule_id && result.action !== 'allow'
      ? `[keel:${result.rule_id}] ${result.message}`
      : ''
    switch (host) {
      case 'cursor':
        // cursor.com/docs/hooks: beforeShellExecution's response carries
        // userMessage (shown to the user) and agentMessage (shown to the
        // agent) alongside `permission`, for ANY permission value — not
        // only deny/ask. The block-path below already uses this envelope
        // (camelCase, matching the file's existing convention); Cursor's
        // own current docs actually show snake_case (user_message/
        // agent_message) for this field, a discrepancy this lane found
        // but did NOT change on the already-shipped block path (out of
        // scope, and untouched code a prior wave rated "docs"-verified) —
        // flagged in evidence for a follow-up lane to resolve for both
        // paths together.
        return {
          blocked: false, exitCode: 0,
          stdout: JSON.stringify({
            permission: 'allow',
            ...(advisory ? { userMessage: advisory, agentMessage: advisory } : {}),
          }),
          stderr: '',
        }
      case 'cline':
        // Best-effort, NOT verified against installed @cline/core types
        // (that verification, done for the block path's HOOK_CONTROL
        // envelope, did not cover a warn/allow message — see evidence).
        // External docs describe a `systemMessage` field as user-visible
        // in Cline's newer hook response shape; added additively onto the
        // existing HOOK_CONTROL envelope so a cline that ignores the
        // unknown field is no worse off than before.
        return {
          blocked: false, exitCode: 0,
          stdout: advisory
            ? `HOOK_CONTROL\t${JSON.stringify({ cancel: false, systemMessage: advisory })}`
            : '',
          stderr: '',
        }
      case 'claude-code':
      case 'gemini':
        // `permissionDecision` is DELIBERATELY OMITTED here (not set to
        // 'allow') — keel's `warn` is "this is the first violation of a
        // deny rule, not blocked yet," NOT "keel has decided this call is
        // fine." Claude Code's own docs list 'defer' as a real decision
        // value specifically meaning "defer to normal permission flow",
        // which only makes sense if 'allow' does the opposite: it would
        // short-circuit Claude Code's OWN permission prompt (the one that
        // would otherwise ask the human before e.g. `git commit
        // --no-verify` runs). Sending 'allow' here would have turned
        // "invisible warning, human still asked" into "visible warning,
        // auto-approved" — a net weakening of the exact guard this lane
        // exists to strengthen. Omitting the field (rather than sending
        // 'defer' explicitly) is the more conservative reading of the
        // docs and keeps the field itself optional, matching "empty
        // object / no decision = normal flow" for the sibling hosts.
        // `additionalContext` is the confirmed model-visible channel,
        // `systemMessage` the confirmed user-visible (transcript-only)
        // one, and — per the anthropics/claude-code#40380 report this
        // lane's research turned up ("systemMessage silently dropped
        // without hookSpecificOutput") — `hookSpecificOutput` stays
        // present even though `permissionDecision` does not, so
        // `systemMessage` is not at risk of being dropped. Gemini
        // inherits this unchanged from the existing Claude-Code-shaped
        // assumption (still "types", not "live").
        return {
          blocked: false, exitCode: 0,
          stdout: advisory
            ? JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  additionalContext: advisory,
                },
                systemMessage: advisory,
              })
            : '',
          stderr: '',
        }
      case 'codex':
        // Deliberately NARROWER than claude-code/gemini above: an external
        // report (github.com/safishamsi/graphify issue #249, "codex-cli
        // 0.120.0 hook failed: unsupported permissionDecision:allow")
        // suggests some Codex CLI versions reject an explicit
        // `permissionDecision: 'allow'`, even though it is accepted
        // elsewhere. `systemMessage` alone is documented as supported for
        // PreToolUse independent of hookSpecificOutput, and exit 0 with no
        // decision already means "proceed" — so this omits
        // hookSpecificOutput entirely rather than risk a hook Codex marks
        // failed. Still "docs" confidence (unchanged from before this
        // lane); a human should live-verify per HUMAN-CHECKLIST.
        return {
          blocked: false, exitCode: 0,
          stdout: advisory ? JSON.stringify({ systemMessage: advisory }) : '',
          stderr: '',
        }
      case 'generic':
      default:
        // No named non-blocking channel is documented for this contract
        // (docs/integrations.md: "stdout: the block reason, IF BLOCKED").
        // Printing the advisory to stdout anyway is a safe, additive
        // upgrade for wrappers that already display stdout regardless of
        // exit code; one that doesn't is no worse off than the previous
        // stderr-only behavior. Recorded honestly as unconfirmed, not
        // claimed as a real channel.
        return { blocked: false, exitCode: 0, stdout: advisory, stderr: '' }
    }
  }

  switch (host) {
    case 'cursor': {
      // `ask` routes to Cursor's own approval UI, the closest match to
      // keel's `prompt`; everything else is a hard deny.
      const permission = result?.action === 'prompt' ? 'ask' : 'deny'
      return {
        blocked: true,
        exitCode: 0,          // Cursor decides from stdout, not the exit code
        stdout: JSON.stringify({ permission, userMessage: text, agentMessage: text }),
        stderr: '',
      }
    }
    case 'cline': {
      // Contract from the installed @cline/core: a HOOK_CONTROL line on
      // stdout, cancel:true stops the call.
      return {
        blocked: true,
        exitCode: 0,
        stdout: `HOOK_CONTROL\t${JSON.stringify({ cancel: true, errorMessage: text })}`,
        stderr: '',
      }
    }
    case 'codex':
    case 'claude-code':
    case 'gemini':
    default: {
      // All three block on exit 2 specifically. For Codex any OTHER non-zero
      // means "the hook failed" and execution continues, so the code
      // matters as much as being non-zero.
      return { blocked: true, exitCode: 2, stdout: '', stderr: text }
    }
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf-8')
}

/**
 * Everything `keel hook <host>` does short of actually exiting the process:
 * read the call, evaluate it, and render the verdict the host must act on.
 * Pulled out of `hookCommand` (a pure function, no `process.exit`) for two
 * reasons:
 *
 * 1. Testability. `process.exit` truly exits — even a mocked one can't be
 *    made to "return" without either falling through into code that
 *    assumes it didn't (e.g. the claim-reach branch below, which must stop
 *    dead at `process.exit(0)` and never reach the tool-call evaluation
 *    beneath it) or being caught by this function's OWN fail-closed catch
 *    and producing a second, spurious verdict. A pure function sidesteps
 *    both traps: tests call `hookVerdict` directly and assert on its
 *    return value, the same way the existing `renderVerdict`/`parsePayload`
 *    tests do, with no process-exit mocking anywhere.
 * 2. Fail-closed coverage. `readStdin()` and `parsePayload()` used to run
 *    BEFORE any try/catch in this function. A stdin stream error (a host
 *    closing its write end mid-read, an EPIPE, ...) thrown out of the
 *    `for await` in readStdin() was an escaped rejection: `index.ts` calls
 *    `program.parse()` (not `parseAsync`), so nothing awaits this
 *    function's promise, and Node's default unhandled-rejection behavior
 *    is to exit the process with code 1. Every exit-code host in
 *    renderVerdict blocks ONLY on exit 2 — Codex's own docs are explicit
 *    that any OTHER non-zero code means "the hook failed, execution
 *    continues" — and the stdout-signaling hosts (cursor/cline) never even
 *    got a stdout envelope written. A crash before evaluation began was
 *    therefore a silent ALLOW: the exact fail-open this lane exists to
 *    close. The fix is the outer try/catch below, covering the entire body
 *    including the stdin read, rendering the same fail-closed verdict
 *    (`renderVerdict(host, null)`) as an in-evaluation error already did.
 */
export async function hookVerdict(hostArg: string, options: { cwd?: string; level?: string } = {}): Promise<HostVerdict> {
  const host = (HOSTS as readonly string[]).includes(hostArg) ? hostArg as Host : 'generic'

  try {
    // The TOOL_NAME/TOOL_INPUT env-var path below is a defensive fallback,
    // not the confirmed contract: Claude Code's current hook docs
    // (code.claude.com/docs/en/hooks) pass the call as JSON on stdin,
    // including session_id — same as every other exit-code host — and that
    // is the path this lane's session-id wiring below actually depends on.
    // It stays as a fallback because it is what an already-live-verified
    // installed hook (session/transcripts/claude-code-force-push.txt) was
    // written against; env vars simply never populate against a real host,
    // so readStdin() is what fires in practice.
    const raw = (host === 'claude-code' || host === 'gemini') && process.env.TOOL_NAME
      ? JSON.stringify({ tool_name: process.env.TOOL_NAME, tool_input: safeJson(process.env.TOOL_INPUT) })
      : await readStdin()

    const call = parsePayload(host, raw)

    // Claim-reach event (v0.4 Phase 1 — today only a Claude Code `Stop`
    // payload sets `call.reasoning`, see ParsedCall's comment). This is
    // structurally NOT a pre-tool-call verdict: the agent has already
    // finished its turn, `type: claim` is `mode: observe` and never blocks,
    // and this detector's own binding contract is "observe-mode ONLY — never
    // blocks." Exiting non-zero here would tell Claude Code's Stop hook to
    // keep the agent going with keel's own internal failure as the reason —
    // a self-inflicted loop for a detector that structurally cannot block —
    // so this path ALWAYS reports exit 0, even if evaluation throws, and
    // never touches renderVerdict's PreToolUse-shaped block/advisory
    // envelopes.
    if (call.reasoning !== undefined) {
      try {
        const cwd = options.cwd || process.cwd()
        const level = (options.level as ProtectionLevel | undefined)
        initEnforce(cwd, level ? { level } : undefined)
        await evaluateClaimText(call.reasoning, { cwd, agent: host, sessionId: call.sessionId })
      } catch {
        // Fail open, on purpose — see the comment above.
      }
      return { blocked: false, exitCode: 0, stdout: '', stderr: '' }
    }

    let result: EnforceResult | null = null
    try {
      const cwd = options.cwd || process.cwd()
      const level = (options.level as ProtectionLevel | undefined)
      initEnforce(cwd, level ? { level } : undefined)
      result = await evaluateToolCall(call.tool, call.args, {
        cwd,
        turnNumber: 0,
        contextTokens: 0,
        level,
        context: 'local',
        agent: host,
        subagentOf: null,
        sessionId: call.sessionId,
      })
    } catch {
      result = null      // fail closed — renderVerdict blocks on null
    }

    return renderVerdict(host, result)
  } catch {
    // Anything that escaped the guards above — most concretely a stdin
    // stream error out of readStdin(), before the per-call try/catch even
    // starts — must still fail CLOSED rather than let an unhandled
    // rejection exit 1. See this function's header comment.
    return renderVerdict(host, null)
  }
}

export async function hookCommand(hostArg: string, options: { cwd?: string; level?: string } = {}) {
  const verdict = await hookVerdict(hostArg, options)
  // Writing and exiting are kept separate: whatever happens with the write
  // below, the process must still exit on the fail-closed code already
  // computed above. This try/catch only guards a synchronous throw out of
  // `.write()` itself (rare, but not the interesting case) — a broken pipe
  // (EPIPE) on stdout/stderr surfaces as an async `'error'` event on the
  // stream, not a synchronous exception, so this catch does not see it.
  // What actually keeps a broken pipe from hanging or crashing this
  // process is the synchronous `process.exit()` two lines down: it runs
  // before Node ever gets back to the event loop to emit that error event,
  // so the exit code still fires either way.
  try {
    if (verdict.stdout) process.stdout.write(`${verdict.stdout}\n`)
    if (verdict.stderr) process.stderr.write(`${verdict.stderr}\n`)
  } catch {
    // The verdict's exit code still fires below regardless of whether the
    // write landed.
  }
  process.exit(verdict.exitCode)
}

function safeJson(text: string | undefined): Record<string, unknown> {
  if (!text) return {}
  try { return asRecord(JSON.parse(text)) } catch { return {} }
}
