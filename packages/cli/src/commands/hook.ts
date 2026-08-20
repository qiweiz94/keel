import { initEnforce, evaluateToolCall, evaluateClaimText, recordPostAction, evaluateOutputText, flushBackgroundWork } from './enforce.js'
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
  /**
   * Speculative, defensive extraction of `body.last_assistant_message` on
   * an ORDINARY pre-tool-call payload (claude-code/codex/gemini), NOT the
   * Stop-shaped claim-reach event `reasoning` (above) covers — deliberately
   * a SEPARATE field, not a reuse of `reasoning`, because `hookCommand`
   * below routes on `call.reasoning !== undefined` alone to decide "this is
   * a Stop event, evaluate it as a claim and never touch `evaluateToolCall`
   * at all"; if this were folded into `reasoning` instead, a PreToolUse
   * payload that ever DID carry `last_assistant_message` would get
   * silently misrouted into the claim-only branch and its tool call would
   * never be evaluated. Neither Claude Code's nor Codex's/Gemini's
   * documented PreToolUse schema is confirmed to carry this field (see
   * `reasoning`'s own citations above, which are Stop-specific) — this is
   * the same "wire it defensively even though today's surveyed hosts don't
   * send it" posture as opencode-plugin's `hookInput?.reasoning` spread in
   * its own `toEnforceInput()`. Threaded into `EnforceInput.reasoning` at
   * the `evaluateToolCall()` call site below (renamed back at that
   * boundary — `EnforceInput` has no reason to know about this
   * routing-safety distinction).
   */
  preToolReasoning?: string
  /**
   * Set when this payload is a POST-action event — the call already ran,
   * with a known (or unknown) outcome — rather than a pre-tool-call one
   * (v1 M2-B1: give claim-to-evidence real reach on the exit-code hosts,
   * matching the opencode plugin's `tool.execute.after` handler). Today set
   * only for a Claude Code `PostToolUse` payload (`hook_event_name ===
   * 'PostToolUse'`, carrying `tool_name`/`tool_input`/`tool_response` —
   * confirmed field NAMES via claude-posttooluse.sh's own installed
   * contract comment, "docs" confidence overall — this repo has not been
   * able to capture a real payload live, see session/v1/EVIDENCE/
   * m2-b1-verify.md), and — by the SAME Claude-Code-shaped-hook citation
   * `parsePayload`'s codex/gemini branch already relies on for PreToolUse —
   * for codex and gemini too.
   *
   * `exitCode` is best-effort and DELIBERATELY conservative: Claude Code's
   * published hook docs describe `tool_response` as "JSON of the tool
   * output" without pinning an exact per-tool schema, and this lane could
   * not verify empirically (this environment's own sandbox refuses to run
   * a nested `claude` CLI invocation — see the evidence file) whether a
   * numeric exit code is even present for the Bash tool. `postToolUseExitCode`
   * below tries several plausible field names and returns `null` (unknown)
   * rather than guessing 0 when none matches — a wrong guess of 0 would
   * discharge a verification obligation on a run that never actually
   * passed, the exact "control that lies" failure class
   * `VerificationTracker.isFakeSatisfy` exists to prevent on the trigger
   * side. `hookVerdict` only calls `markVerificationSatisfied` when
   * `exitCode === 0` is a confirmed value from this payload, never on `null`.
   *
   * Like the Stop-shaped claim-reach path above, this is structurally
   * observe-only: `hookVerdict` NEVER blocks on a PostToolUse-shaped
   * payload, always returns exit 0, even if evaluation throws internally.
   *
   * `outputText` (sprint/lane-c2: real output capture + redaction) is the
   * completed tool's own output text, when this payload carries something
   * recognizable as one — same best-effort, same honesty posture as
   * `exitCode` above, see `postToolUseOutputText`'s own comment. Unlike
   * `exitCode`, there is no safe default to fall back to on "unknown" —
   * `undefined` here just means "nothing to scan," not "assume clean."
   */
  postAction?: { tool: string; args: Record<string, unknown>; exitCode: number | null; outputText?: string }
  /**
   * Set when the payload could not supply the ONE field every rule needs to
   * match against: a real tool identity (or, for the env-var TOOL_INPUT
   * path, real argument data — present-but-corrupt is data LOSS, distinct
   * from legitimately absent). `hookVerdict` fails closed on this rather
   * than letting `tool: 'unknown', args: {}` sail through evaluation and
   * match nothing (v1 M1r-2 — locked product decision: degenerate input
   * fails closed, never a silent allow). Never set for a value that is
   * merely missing where absence is normal (e.g. no session_id, no
   * tool_input for a zero-arg tool) — only for JSON that failed to parse,
   * a non-object/array top level, or a missing/blank/non-string tool
   * identity field.
   */
  degenerate?: boolean
}

/**
 * A missing/blank/non-string tool name is not "a call to a tool literally
 * named unknown" — it is proof the payload lost the one field every rule
 * pattern matches against. Every host branch below runs identity through
 * this so the degenerate flag is set uniformly, not reinvented per host.
 */
function toolField(value: unknown): { tool: string; degenerate?: true } {
  return typeof value === 'string' && value.length > 0
    ? { tool: value }
    : { tool: 'unknown', degenerate: true }
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
 * Best-effort exit-code extraction from a PostToolUse `tool_response`
 * payload. See ParsedCall.postAction's comment for why this is
 * deliberately conservative: it tries several plausible field names and
 * falls back to `null` (unknown, never discharges) rather than guessing —
 * a wrong guess of 0 would clear a verification obligation on a run that
 * never actually passed.
 */
function postToolUseExitCode(toolResponse: unknown): number | null {
  const response = asRecord(toolResponse)
  for (const key of ['exit_code', 'exitCode', 'exitStatus']) {
    const value = response[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  if (typeof response.success === 'boolean') return response.success ? 0 : 1
  if (typeof response.is_error === 'boolean') return response.is_error ? 1 : 0
  if (response.interrupted === true) return 1
  return null
}

/**
 * Best-effort extraction of a completed tool's OWN output text from a
 * PostToolUse-shaped payload (sprint/lane-c2: real output capture +
 * redaction, the CLI-hook-layer counterpart to the OpenCode plugin's
 * `tool.execute.after` output-mutation wiring — see plugin.ts and
 * pipeline.ts's `evaluateOutput()`). Same conservative posture as
 * `postToolUseExitCode` above, for the same underlying reason: this
 * repo's own live-verification budget could not capture a real Claude
 * Code PostToolUse payload (docs/integrations.md's honesty table), so the
 * exact field NAME is unconfirmed. Two independent citations disagree —
 * the installed `claude-posttooluse.sh` template's own contract comment
 * says `TOOL_RESPONSE — JSON of the tool output` (i.e. nested inside
 * `tool_response`, which is also what `postToolUseExitCode` already reads),
 * while a direct fetch of code.claude.com/docs/en/hooks for THIS lane
 * described a top-level `tool_output` field name instead. Both are tried,
 * same "send/read both spellings" precedent as `renderVerdict`'s Cursor
 * camelCase/snake_case fix — and if NEITHER matches a real payload, this
 * silently returns `undefined` (nothing scanned), not a guessed default;
 * that silence is itself worth stating plainly rather than treating an
 * unconfirmed extraction as reassurance that output scanning "works."
 */
function postToolUseOutputText(body: Record<string, unknown>): string | undefined {
  const container = asRecord(body.tool_response ?? body.tool_output)
  for (const key of ['output', 'stdout', 'content', 'text', 'result']) {
    const value = container[key]
    if (typeof value === 'string' && value) return value
  }
  if (typeof body.tool_response === 'string' && body.tool_response) return body.tool_response
  if (typeof body.tool_output === 'string' && body.tool_output) return body.tool_output
  return undefined
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
    // Empty stdin hits this same catch (JSON.parse('') throws) — a
    // misconfigured hook that never sends a payload is indistinguishable
    // from a genuinely garbled one, and both must fail closed the same way.
    return { tool: 'unknown', args: {}, degenerate: true }
  }

  switch (host) {
    case 'cline': {
      const pre = asRecord(body.preToolUse)
      const identity = toolField(pre.toolName)
      return {
        ...identity,
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
        // Unlike every other host, Cursor's shell shape carries the tool
        // identity AND the argument in the SAME field: `command` is not an
        // optional argument on an otherwise-identified call, it IS the
        // call. A blank command here is the same consequence as (a2)'s
        // empty stdin — lost data, not a legitimate zero-arg tool — so it
        // gets the same degenerate treatment rather than the "missing args
        // is fine" line drawn for TOOL_INPUT elsewhere in this file.
        return body.command.length > 0
          ? { tool: 'bash', args: { command: body.command }, sessionId }
          : { tool: 'bash', args: { command: body.command }, sessionId, degenerate: true }
      }
      const identity = toolField(body.tool_name)
      return { ...identity, args: asRecord(body.tool_input), sessionId }
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
      //
      // Gated on hook_event_name alone now — NOT also on
      // last_assistant_message being a valid string. A Stop payload with a
      // missing/null message used to fall through to the ordinary
      // tool-call branch below, where the absent tool_name produced
      // `tool: 'unknown'`; that was harmless only because 'unknown' never
      // matched a real rule. Once a missing tool identity fails closed
      // (this lane), that same fall-through would have turned a Stop event
      // — required by its own contract to NEVER block (see hookVerdict's
      // header comment: exit 2 on Stop is a self-inflicted loop) — into an
      // exit-2 block. Routing every Stop-shaped payload through the
      // claim-reach path (reasoning: '' when the message is missing/not a
      // string) keeps it on the structurally-can't-block channel instead.
      if (body.hook_event_name === 'Stop') {
        return {
          tool: 'assistant-message',
          args: {},
          sessionId: stringField(body.session_id),
          reasoning: typeof body.last_assistant_message === 'string' ? body.last_assistant_message : '',
        }
      }
      // PostToolUse-shaped payload (v1 M2-B1): the call already ran.
      // Gated on hook_event_name alone, mirroring the Stop gate above —
      // not on the presence/absence of tool_response, so a malformed
      // PreToolUse payload is never misread as a completed call. See
      // ParsedCall.postAction's comment for the exit-code honesty caveat.
      if (body.hook_event_name === 'PostToolUse') {
        const identity = toolField(body.tool_name)
        return {
          tool: 'post-action',
          args: {},
          sessionId: stringField(body.session_id),
          postAction: {
            tool: identity.tool,
            args: asRecord(body.tool_input),
            exitCode: postToolUseExitCode(body.tool_response),
            outputText: postToolUseOutputText(body),
          },
        }
      }
      const identity = toolField(body.tool_name)
      return {
        ...identity,
        args: asRecord(body.tool_input),
        sessionId: stringField(body.session_id),
        // See ParsedCall.preToolReasoning's own comment for why this is a
        // separate field from `reasoning` above. PLUMBING ONLY, not a live
        // fix by itself: every prior call site reaching `evaluateToolCall()`
        // (Claude Code, Codex, Gemini, Cursor, Cline) left `reasoning`
        // unset entirely regardless of what the payload carried, and that
        // part IS now wired end-to-end (see the call site below) — but
        // `body.last_assistant_message` is documented ONLY on a Stop-shaped
        // payload (this branch's own comment above), so on a real,
        // currently-observed PreToolUse call this extracts `undefined`
        // every time. `unless_reasoning` and the `level: protect`
        // deceptive-reasoning floor detector (pipeline.ts) still have NO
        // live reach through any CLI hook path today — this closes the
        // "never wired even if the data existed" half of the gap, not the
        // "the data doesn't exist yet" half. The opencode-plugin's own
        // `hookInput?.reasoning` spread is the SAME shape of unpopulated
        // plumbing, not a working counterexample — see its own comment
        // ("surveyed and found unpopulated by OpenCode's own
        // PreToolUse-shaped input").  The ACTUAL data source that would
        // close this for real is Claude Code's PreToolUse `transcript_path`
        // (reading the last assistant message from it) — out of scope here
        // as a restructure, not a threading fix.
        preToolReasoning: typeof body.last_assistant_message === 'string' ? body.last_assistant_message : undefined,
      }
    }
    case 'codex':
    case 'gemini': {
      // Gemini CLI ships `gemini hooks migrate --from-claude`, which
      // advertises equivalence with the Claude Code hook format, so it
      // reads the same payload rather than a guessed one of its own.
      // `session_id` is on the base PreToolUse schema for both Claude Code
      // (code.claude.com/docs/en/hooks) and Codex (which converged on the
      // same hookSpecificOutput-shaped hook contract).
      //
      // v1 M2-B1: Stop and PostToolUse are now wired here too, on the SAME
      // citation tier as the PreToolUse branch above (hook.ts's own prior
      // comment flagged Codex's identical Stop/last_assistant_message shape
      // as "documented ... but deliberately NOT wired here this phase" —
      // this is that follow-up). Confidence stays "docs" for both hosts:
      // neither has been exercised against a live session in this repo
      // (gemini is auth-blocked in this lane's environment; codex's own
      // installer already carries an "UNVERIFIED against a live Codex CLI"
      // note for PreToolUse, which applies here too) — see docs/
      // integrations.md and session/v1/EVIDENCE/m2-b1-verify.md.
      if (body.hook_event_name === 'Stop') {
        return {
          tool: 'assistant-message',
          args: {},
          sessionId: stringField(body.session_id),
          reasoning: typeof body.last_assistant_message === 'string' ? body.last_assistant_message : '',
        }
      }
      if (body.hook_event_name === 'PostToolUse') {
        const identity = toolField(body.tool_name)
        return {
          tool: 'post-action',
          args: {},
          sessionId: stringField(body.session_id),
          postAction: {
            tool: identity.tool,
            args: asRecord(body.tool_input),
            exitCode: postToolUseExitCode(body.tool_response),
            outputText: postToolUseOutputText(body),
          },
        }
      }
      const identity = toolField(body.tool_name)
      return {
        ...identity,
        args: asRecord(body.tool_input),
        sessionId: stringField(body.session_id),
        // See ParsedCall.preToolReasoning's comment — same field, same
        // reasoning, same citation tier for these two hosts.
        preToolReasoning: typeof body.last_assistant_message === 'string' ? body.last_assistant_message : undefined,
      }
    }
    case 'generic':
    default: {
      const identity = toolField(body.tool)
      return { ...identity, args: asRecord(body.args), sessionId: stringField(body.session_id) }
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
        // user_message (shown to the user) and agent_message (shown to the
        // agent) alongside `permission`, for ANY permission value — not
        // only deny/ask. FIX (M4 host-breadth lane): a prior wave shipped
        // this envelope in camelCase (userMessage/agentMessage) and its own
        // evidence (session/EVIDENCE/wave3-warnsurface.md §"Cursor
        // field-casing discrepancy") already flagged that a live fetch of
        // cursor.com/docs/hooks returns snake_case — re-fetched live again
        // this lane (same result) before changing anything. Sent under
        // BOTH keys rather than switched outright: hook.ts:440-449 (Codex's
        // `permissionDecision:'allow'` rejection, external bug report
        // #249) is this same repo's own precedent that an extra/wrong field
        // can make a host mark a hook FAILED, not merely ignore it — a
        // failed hook here would fail OPEN (advisory swallowed entirely),
        // which is worse than the pre-fix state. Sending both spellings
        // costs nothing if Cursor ignores unknown keys (the common case)
        // and is strictly safer than a blind swap with no live Cursor
        // access to confirm either behavior in this environment.
        // The BLOCK path below (case 'cursor' under `blocked`) carried the
        // identical camelCase-only gap and now sends both spellings too,
        // for the same reason given above.
        return {
          blocked: false, exitCode: 0,
          stdout: JSON.stringify({
            permission: 'allow',
            ...(advisory
              ? { userMessage: advisory, agentMessage: advisory, user_message: advisory, agent_message: advisory }
              : {}),
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
      // Sent under both camelCase and snake_case keys — same fix, same
      // reasoning, as the advisory/non-blocking cursor path above: a live
      // fetch of cursor.com/docs/hooks returns snake_case
      // (user_message/agent_message), but a prior wave shipped this
      // envelope camelCase-only. Both spellings cost nothing if Cursor
      // ignores the unknown key, and `permission` alone still gates the
      // actual block even if one spelling's message text doesn't render.
      return {
        blocked: true,
        exitCode: 0,          // Cursor decides from stdout, not the exit code
        stdout: JSON.stringify({
          permission,
          userMessage: text, agentMessage: text,
          user_message: text, agent_message: text,
        }),
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
      //
      // `generic` falls through to this same default (no case of its own).
      // docs/integrations.md's generic contract table once said "stdout:
      // the block reason" while this always wrote it to stderr — a real
      // drift, caught by lane review. `fail-closed.test.ts` already has
      // passing tests asserting stderr for the generic host, meaning real
      // integrations built against this host type adapted to the CODE, not
      // the doc — so the doc was fixed to say stderr instead of moving this
      // stream and risking already-relied-upon behavior. stderr here is the
      // intentional, documented-to-match-code contract; keep it that way
      // unless a deliberate, test-updating decision says otherwise.
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
    // Tracks whether TOOL_INPUT was PRESENT but failed to parse — data loss,
    // not the legitimate "no arguments" case. safeJson() used to swallow a
    // truncated TOOL_INPUT into `{}` with no trace of the truncation: a real
    // tool name plus empty args looks exactly like a legitimate zero-arg
    // call, so nothing downstream could tell the arguments were dropped
    // (v1 M1r-2's (a3) gap). An ABSENT TOOL_INPUT stays non-degenerate —
    // many real tools take no arguments — only a present-but-unparseable
    // value marks the call.
    let toolInputCorrupt = false
    const raw = (host === 'claude-code' || host === 'gemini') && process.env.TOOL_NAME
      ? (() => {
          const built = buildEnvVarPayload(process.env)
          toolInputCorrupt = built.toolInputCorrupt
          return built.raw
        })()
      : await readStdin()

    const call = parsePayload(host, raw)
    if (toolInputCorrupt) call.degenerate = true

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

    // Post-action event (v1 M2-B1 — see ParsedCall.postAction's comment).
    // The call already ran; this discharges a pending verification/claim
    // obligation on CONFIRMED success and always records the outcome,
    // mirroring the opencode plugin's `tool.execute.after` handler. Same
    // structurally-can't-block shape as the claim-reach branch above: a
    // completed tool call cannot be un-run, so this path ALWAYS reports
    // exit 0, even if evaluation throws.
    if (call.postAction) {
      let outputWarning = ''
      try {
        const cwd = options.cwd || process.cwd()
        const level = (options.level as ProtectionLevel | undefined)
        initEnforce(cwd, level ? { level } : undefined)
        await recordPostAction(call.postAction.tool, call.postAction.args, call.postAction.exitCode, { cwd, agent: host, sessionId: call.sessionId })
        // Real output capture + redaction (sprint/lane-c2), CLI-hook-host
        // ceiling: unlike the OpenCode plugin (packages/opencode-plugin/src/
        // plugin.ts), NOTHING on this path can rewrite output that already
        // reached the model — the call already ran and its result already
        // went out before this hook ever fires (this branch's own header
        // comment). The honest ceiling here is Claude Code's documented
        // `PostToolUse` `additionalContext` field: a context-injection
        // channel the model sees on its NEXT turn, not a literal rewrite —
        // see docs/exfil.md's "Output redaction" section. Only built when
        // `outputText` was actually extracted (postToolUseOutputText's own
        // comment: silence there means "nothing to scan," not "clean").
        if (call.postAction.outputText) {
          const result = await evaluateOutputText(
            call.postAction.tool, call.postAction.args, call.postAction.outputText,
            { cwd, agent: host, sessionId: call.sessionId },
          )
          if (result.action === 'redact' && result.rule_id) {
            outputWarning = `[keel:${result.rule_id}] The last tool's output matched a secret-shaped pattern (${(result.redacted_rule_ids || [result.rule_id]).join(', ')}). `
              + 'Keel could not remove it from what you already received — this host\'s PostToolUse hook cannot rewrite delivered '
              + 'tool output, only warn after the fact. Treat that value as exposed: do not repeat, log, or transmit it, and tell the user to rotate it.'
          }
        }
      } catch {
        // Fail open, on purpose — see the comment above.
      }
      // `hookSpecificOutput.hookEventName: 'PostToolUse'` (not 'PreToolUse',
      // unlike renderVerdict's advisory case above) — this response answers
      // THIS hook invocation specifically. `systemMessage` alongside it for
      // the same reason renderVerdict's advisory path sends both: the
      // confirmed user-visible channel and the confirmed model-visible one,
      // per anthropics/claude-code#40380's "systemMessage silently dropped
      // without hookSpecificOutput" report cited there.
      return {
        blocked: false, exitCode: 0,
        stdout: outputWarning
          ? JSON.stringify({
              hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: outputWarning },
              systemMessage: outputWarning,
            })
          : '',
        stderr: '',
      }
    }

    // Degenerate payload (empty stdin, unparseable JSON, a missing/blank
    // tool identity, or truncated TOOL_INPUT data) — the input needed to
    // evaluate this call was lost, so it must never reach `evaluateToolCall`
    // and silently match nothing. Render exactly the same fail-closed
    // verdict as an internal keel failure (`result === null` below):
    // per-host tested already (cursor's deny envelope, cline's cancel,
    // exit 2 for the exit-code hosts) and honest — keel genuinely could not
    // evaluate a call it cannot identify.
    if (call.degenerate) {
      return renderVerdict(host, null)
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
        // See ParsedCall.preToolReasoning's comment and the claude-code/
        // codex/gemini parsePayload branches above: this is the PreToolUse
        // call site every real invocation from those hosts goes through,
        // and it used to leave `reasoning` unset entirely regardless of
        // what the payload carried. `evaluateToolCall`'s `extra.reasoning`
        // already threads straight into `EnforceInput.reasoning`; this was
        // simply never wired to it, and now is. NOT `call.reasoning` — that
        // field is the Stop-shaped claim-reach event's text, which never
        // coexists with a real tool call in the same payload (see
        // preToolReasoning's comment for why the two must stay separate
        // fields).
        //
        // HONESTY NOTE (do not read this as "the floor now fires"):
        // `unless_reasoning` and the `level: protect` deceptive-reasoning
        // floor detector (pipeline.ts) still have NO live reach through any
        // CLI hook path — `call.preToolReasoning` is `undefined` on every
        // currently-documented real payload from every host (see its own
        // comment). This closes the WIRING gap (the value would flow
        // through correctly the moment any host's payload, or a future
        // extraction from `transcript_path`, actually populates it); it
        // does not manufacture the missing data source.
        reasoning: call.preToolReasoning,
      })
    } catch {
      result = null      // fail closed — renderVerdict blocks on null
    }

    // Slopsquatting deny-on-retry fix (v1 M2-B1, same root cause as the
    // discharge gap above): a `type: package` rule cache miss fires
    // `scheduleBackgroundVerification` with `void` inside `evaluateToolCall`
    // (pipeline.ts), never awaited on the hot path. In a long-lived host
    // that promise settles on its own and warms `PackageVerifierCache` for
    // the next call; here, `hookCommand` calls `process.exit()` right after
    // this function returns, which would otherwise tear down the event
    // loop before the lookup ever got a turn — so a hallucinated package
    // name would prompt on every single retry instead of converging to a
    // deterministic deny. Bounded (2500ms) so a hung fetch cannot make this
    // hook itself hang; a no-op (returns immediately) on every call that
    // never touched a package rule.
    await flushBackgroundWork()

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

function safeJson(text: string | undefined): { value: Record<string, unknown>; corrupt: boolean } {
  if (!text) return { value: {}, corrupt: false }
  try { return { value: asRecord(JSON.parse(text)), corrupt: false } } catch { return { value: {}, corrupt: true } }
}

/**
 * Builds the raw JSON body for `hookVerdict`'s TOOL_NAME/TOOL_INPUT env-var
 * fallback path (claude-code/gemini only — see the caller's comment).
 * Factored out of that inline closure so this specific routing decision —
 * PostToolUse-shaped vs. bare pre-tool-call-shaped — can be unit tested
 * directly against `parsePayload`, the same way every other host's payload
 * shape already is (see hook-command.test.ts), instead of only indirectly
 * through a spawned process reading real env vars.
 *
 * TOOL_RESPONSE present is the ONLY signal this path has that the call is a
 * completed PostToolUse one rather than a pre-tool-call PreToolUse one —
 * there is no separate hook_event_name env var — so its presence routes to
 * the PostToolUse shape (`hook_event_name: 'PostToolUse'` plus
 * `tool_response`), matching what `templates/claude-posttooluse-verify.sh`'s
 * own contract comment documents Claude Code populates for a completed
 * call. Absent, it stays the original bare pre-tool-call shape.
 *
 * Gated on TRUTHY, not merely `!== undefined` — matching the caller's own
 * `&& process.env.TOOL_NAME` precedent on this same env-var path. A shell
 * wrapper that exports all three vars unconditionally would set
 * TOOL_RESPONSE="" (defined-but-empty) for an ordinary pre-tool-call
 * invocation, and PostToolUse routing always exits 0 without evaluating a
 * rule (see hookVerdict's postAction branch) — so treating empty-string as
 * "present" would fail a real block open. The asymmetry is one-directional:
 * a false PostToolUse read on an empty string silently drops a block, while
 * a false PreToolUse read on a genuinely completed call only keeps this
 * path's prior, already-accepted behavior. No confirmed source shows
 * whether a real host ever exports TOOL_RESPONSE empty rather than unset,
 * but the fallback stays truthy-gated because the failure mode if it does is
 * the closed side, not the open one.
 */
export function buildEnvVarPayload(
  env: { TOOL_NAME?: string; TOOL_INPUT?: string; TOOL_RESPONSE?: string },
): { raw: string; toolInputCorrupt: boolean } {
  const parsed = safeJson(env.TOOL_INPUT)
  const raw = env.TOOL_RESPONSE
    ? JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: env.TOOL_NAME,
        tool_input: parsed.value,
        tool_response: safeJson(env.TOOL_RESPONSE).value,
      })
    : JSON.stringify({ tool_name: env.TOOL_NAME, tool_input: parsed.value })
  return { raw, toolInputCorrupt: parsed.corrupt }
}
