import { describe, it, expect } from 'vitest'
import { renderVerdict, parsePayload, buildEnvVarPayload, HOSTS } from '../commands/hook.js'
import type { EnforceResult } from '../core/types.js'

/**
 * `keel hook <host>` replaced four shell scripts that each extracted the
 * verdict from JSON with sed. That could not survive an escaped quote:
 *
 *   intended : Keel blocked this action: Use "--force-with-lease" instead
 *   actual   : Keel blocked this action: Use \
 *
 * The output stayed valid JSON, so nothing errored and no test failed —
 * the user was told they were blocked with the reason cut off at the
 * first quote. These assert the messages survive intact.
 */

const verdict = (over: Partial<EnforceResult> = {}): EnforceResult => ({
  action: 'deny',
  rule_id: 'no-force-push',
  rule_name: 'no-force-push',
  message: 'Use "--force-with-lease" instead of --force.',
  timestamp: '2026-08-04T00:00:00.000Z',
  ...over,
} as EnforceResult)

describe('hook payload parsing', () => {
  it('reads each host’s own payload shape', () => {
    expect(parsePayload('cline', JSON.stringify({
      preToolUse: { toolName: 'bash', parameters: { command: 'rm -rf /' } },
    }))).toEqual({ tool: 'bash', args: { command: 'rm -rf /' } })

    expect(parsePayload('cursor', JSON.stringify({ command: 'rm -rf /' })))
      .toEqual({ tool: 'bash', args: { command: 'rm -rf /' } })

    expect(parsePayload('codex', JSON.stringify({
      tool_name: 'Write', tool_input: { filePath: 'a.ts' },
    }))).toEqual({ tool: 'Write', args: { filePath: 'a.ts' } })

    expect(parsePayload('generic', JSON.stringify({ tool: 'bash', args: { command: 'ls' } })))
      .toEqual({ tool: 'bash', args: { command: 'ls' } })
  })

  it('degrades to an unknown tool rather than throwing on junk, and flags it degenerate so the caller fails closed instead of silently evaluating it', () => {
    // A hook that crashes is a hook the host skips — a silent fail-open.
    // Degrading to a well-formed `unknown`-tool call avoids that crash, but
    // (v1 M1r-2) that call must still be marked so hookVerdict blocks it
    // rather than letting it fall through pipeline evaluation matching no
    // rule — see ParsedCall.degenerate's comment in hook.ts.
    expect(parsePayload('cline', 'not json at all')).toEqual({ tool: 'unknown', args: {}, degenerate: true })
    expect(parsePayload('cursor', '')).toEqual({ tool: 'unknown', args: {}, degenerate: true })
  })

  describe('claude-code Stop payload (v0.4 Phase 1 — claim-to-evidence real reach)', () => {
    it('extracts last_assistant_message as `reasoning` when hook_event_name is Stop', () => {
      const call = parsePayload('claude-code', JSON.stringify({
        hook_event_name: 'Stop', session_id: 'ses_1', last_assistant_message: 'Done, all tests pass.',
      }))
      expect(call.reasoning).toBe('Done, all tests pass.')
      expect(call.tool).toBe('assistant-message')
      expect(call.args).toEqual({})
      expect(call.sessionId).toBe('ses_1')
    })

    it('an ordinary PreToolUse payload never sets `reasoning` — the Stop branch is gated on hook_event_name, not on tool_name being absent', () => {
      const call = parsePayload('claude-code', JSON.stringify({
        tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'ses_2',
      }))
      expect(call.reasoning).toBeUndefined()
      expect(call.tool).toBe('Bash')
    })

    // Regression: `hookVerdict`'s actual PreToolUse `evaluateToolCall()`
    // call site never set `reasoning` at all, on ANY host — that WIRING gap
    // is what this closes, via a SEPARATE `preToolReasoning` field (not a
    // reuse of `reasoning` above): `hookVerdict` routes to the
    // structurally-can't-block claim-reach path purely on `call.reasoning
    // !== undefined`, so folding this into the same field would misroute
    // an ordinary tool call into that branch and never evaluate it at all
    // if `last_assistant_message` were ever present on a PreToolUse-shaped
    // payload — see ParsedCall.preToolReasoning's own comment in hook.ts.
    //
    // HONESTY NOTE: these tests construct payloads that CONTAIN
    // `last_assistant_message` to prove the plumbing carries it through
    // correctly when present. No currently-documented real payload from
    // any surveyed host (Claude Code, Codex, Gemini) actually sends this
    // field on an ordinary PreToolUse event — it is Stop-only per every
    // citation in this file. So `unless_reasoning` and the `level: protect`
    // deceptive-reasoning floor detector (pipeline.ts) still have NO live
    // reach through any CLI hook path today; this only guarantees the data
    // WOULD flow through correctly the moment a host (or a future
    // `transcript_path`-based extraction) actually provides it.
    describe('preToolReasoning — reasoning-floor PLUMBING on an ORDINARY PreToolUse payload (v0.4 Phase 1 follow-up; wiring only, no live host populates this yet)', () => {
      it('extracts last_assistant_message as `preToolReasoning` (never `reasoning`) on claude-code, codex, and gemini PreToolUse payloads', () => {
        for (const host of ['claude-code', 'codex', 'gemini'] as const) {
          const call = parsePayload(host, JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'git push --force origin main' },
            session_id: 'ses_reasoning',
            last_assistant_message: "I'll bypass the check and disable safety since the user said it's fine.",
          }))
          expect(call.preToolReasoning).toBe("I'll bypass the check and disable safety since the user said it's fine.")
          // The claim-reach routing field MUST stay untouched — this is
          // the actual bug this shape guards against: a shared field here
          // would make `call.reasoning !== undefined` true and misroute
          // this tool call into the claim-only evaluator, which never
          // calls `evaluateToolCall` at all.
          expect(call.reasoning).toBeUndefined()
          expect(call.tool).toBe('Bash')
          expect(call.args).toEqual({ command: 'git push --force origin main' })
        }
      })

      it('leaves `preToolReasoning` undefined when the payload carries no last_assistant_message at all (the common case today)', () => {
        for (const host of ['claude-code', 'codex', 'gemini'] as const) {
          const call = parsePayload(host, JSON.stringify({
            tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'ses_no_reasoning',
          }))
          expect(call.preToolReasoning).toBeUndefined()
        }
      })

      it('cline, cursor, and generic payloads never set `preToolReasoning` — no citation confirms an equivalent field on those hosts', () => {
        expect(parsePayload('cline', JSON.stringify({
          preToolUse: { toolName: 'bash', parameters: { command: 'ls' } },
          last_assistant_message: 'should not be picked up',
        })).preToolReasoning).toBeUndefined()
        expect(parsePayload('cursor', JSON.stringify({
          command: 'ls', last_assistant_message: 'should not be picked up',
        })).preToolReasoning).toBeUndefined()
        expect(parsePayload('generic', JSON.stringify({
          tool: 'bash', args: { command: 'ls' }, last_assistant_message: 'should not be picked up',
        })).preToolReasoning).toBeUndefined()
      })
    })

    it('a payload claiming hook_event_name: Stop but missing last_assistant_message STAYS on the claim-reach path with empty reasoning, rather than falling back to the ordinary tool-call shape', () => {
      // Pre-v1-M1r-2 this fell back to the ordinary tool-call branch, where
      // an absent tool_name produced `tool: 'unknown'` — harmless only
      // because 'unknown' never matched a real rule. Once a missing tool
      // identity fails closed (this lane), that fall-through would have
      // turned a Stop event into an exit-2 block — violating Stop's own
      // contract that it can NEVER block a self-inflicted-loop risk (see
      // hookVerdict's header comment). Every Stop-shaped payload — valid
      // message or not — now stays on the structurally-can't-block
      // claim-reach path instead.
      const call = parsePayload('claude-code', JSON.stringify({
        hook_event_name: 'Stop', session_id: 'ses_3',
      }))
      expect(call.reasoning).toBe('')
      expect(call.tool).toBe('assistant-message')
      expect(call.degenerate).toBeUndefined()
    })

    it('v1 M2-B1: codex and gemini now get the Stop branch too — same citation tier as claude-code (both document the identical Stop/last_assistant_message shape), docs confidence only (see hook.ts\'s codex/gemini branch comment)', () => {
      for (const host of ['codex', 'gemini'] as const) {
        const call = parsePayload(host, JSON.stringify({
          hook_event_name: 'Stop', session_id: 'ses_4', last_assistant_message: 'Done, all tests pass.',
        }))
        expect(call.reasoning).toBe('Done, all tests pass.')
        expect(call.tool).toBe('assistant-message')
      }
    })

    it('v1 M2-B1: a PostToolUse-shaped payload sets `postAction` on claude-code, codex and gemini, with a null exit code when no plausible success field is present (sprint/lane-c2: and outputText, when a plausible output field IS present — see postToolUseOutputText below)', () => {
      for (const host of ['claude-code', 'codex', 'gemini'] as const) {
        const call = parsePayload(host, JSON.stringify({
          hook_event_name: 'PostToolUse', session_id: 'ses_5',
          tool_name: 'Bash', tool_input: { command: 'npm test' },
          tool_response: { stdout: 'ok', stderr: '' },
        }))
        expect(call.postAction).toEqual({ tool: 'Bash', args: { command: 'npm test' }, exitCode: null, outputText: 'ok' })
        expect(call.reasoning).toBeUndefined()
      }
    })

    describe('sprint/lane-c2: postToolUseOutputText — real output capture, best-effort field extraction', () => {
      it('reads `stdout`/`output`/`content`/`text`/`result` nested under tool_response, in that priority order', () => {
        const cases: Array<[Record<string, unknown>, string]> = [
          [{ output: 'from output' }, 'from output'],
          [{ stdout: 'from stdout' }, 'from stdout'],
          [{ content: 'from content' }, 'from content'],
          [{ text: 'from text' }, 'from text'],
          [{ result: 'from result' }, 'from result'],
          [{ output: 'wins', stdout: 'loses' }, 'wins'],
        ]
        for (const [toolResponse, expected] of cases) {
          const call = parsePayload('claude-code', JSON.stringify({
            hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: toolResponse,
          }))
          expect(call.postAction?.outputText).toBe(expected)
        }
      })

      it('also reads a top-level `tool_output` field (the docs-cited spelling, alongside tool_response — both are tried)', () => {
        const call = parsePayload('claude-code', JSON.stringify({
          hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {},
          tool_output: { stdout: 'from tool_output' },
        }))
        expect(call.postAction?.outputText).toBe('from tool_output')
      })

      it('reads a bare-string tool_response/tool_output directly, not only a nested object shape', () => {
        const a = parsePayload('claude-code', JSON.stringify({
          hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: 'bare string response',
        }))
        expect(a.postAction?.outputText).toBe('bare string response')
      })

      it('is undefined (not a guessed empty string) when nothing plausible matches — silence, not a false "clean" signal', () => {
        const call = parsePayload('claude-code', JSON.stringify({
          hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: { exit_code: 0 },
        }))
        expect(call.postAction?.outputText).toBeUndefined()
      })
    })

    it('v1 M2-B1: postToolUseExitCode reads a plausible success signal when present, deliberately conservative about which field names count', () => {
      const pass = parsePayload('claude-code', JSON.stringify({
        hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {},
        tool_response: { exit_code: 0 },
      }))
      expect(pass.postAction?.exitCode).toBe(0)

      const fail = parsePayload('claude-code', JSON.stringify({
        hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {},
        tool_response: { exit_code: 1 },
      }))
      expect(fail.postAction?.exitCode).toBe(1)

      const interrupted = parsePayload('claude-code', JSON.stringify({
        hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {},
        tool_response: { interrupted: true },
      }))
      expect(interrupted.postAction?.exitCode).toBe(1)
    })

    it('v1 M2-B1: an ordinary PreToolUse payload never sets `postAction` — gated on hook_event_name, not on tool_response being absent', () => {
      const call = parsePayload('claude-code', JSON.stringify({
        tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'ses_6',
      }))
      expect(call.postAction).toBeUndefined()
    })

    describe('buildEnvVarPayload — the TOOL_NAME/TOOL_INPUT/TOOL_RESPONSE env-var fallback path (claude-code/gemini)', () => {
      // Claude Code's own installed contract comment
      // (templates/claude-posttooluse-verify.sh: "carrying TOOL_NAME/
      // TOOL_INPUT/TOOL_RESPONSE (env or stdin — `keel hook claude-code`
      // reads either)") documents that a real PostToolUse call can arrive
      // this way, not only on stdin. Before this fix, hookVerdict's env-var
      // branch built a bare {tool_name, tool_input} body with no
      // hook_event_name regardless of TOOL_RESPONSE, so parsePayload's
      // PostToolUse branch (gated on hook_event_name alone) never
      // triggered — a completed call fell through to being evaluated as an
      // ordinary pre-tool-call instead, discarding its real outcome and
      // risking a spurious exit-2 block for a call the host can no longer
      // stop. These prove the fix at the same level hook-command.test.ts
      // already proves every other host's payload shape: parsePayload's
      // resulting ParsedCall, not merely the exit code of a spawned
      // process.
      it('TOOL_RESPONSE present: builds a PostToolUse-shaped body that parsePayload turns into a postAction-shaped ParsedCall — mirrors the stdin-shaped PostToolUse test above, but via env vars', () => {
        const { raw, toolInputCorrupt } = buildEnvVarPayload({
          TOOL_NAME: 'Bash',
          TOOL_INPUT: JSON.stringify({ command: 'npm test' }),
          TOOL_RESPONSE: JSON.stringify({ exit_code: 0, stdout: 'ok' }),
        })
        expect(toolInputCorrupt).toBe(false)

        const call = parsePayload('claude-code', raw)
        expect(call.postAction).toEqual({ tool: 'Bash', args: { command: 'npm test' }, exitCode: 0, outputText: 'ok' })
        expect(call.reasoning).toBeUndefined()
      })

      it('TOOL_RESPONSE absent: still builds the original bare pre-tool-call shape — the fix is additive, the ordinary PreToolUse-via-env-vars case is unchanged', () => {
        const { raw } = buildEnvVarPayload({
          TOOL_NAME: 'Bash',
          TOOL_INPUT: JSON.stringify({ command: 'ls -la' }),
        })
        const call = parsePayload('claude-code', raw)
        expect(call.tool).toBe('Bash')
        expect(call.args).toEqual({ command: 'ls -la' })
        expect(call.postAction).toBeUndefined()
      })

      it('TOOL_RESPONSE present but TOOL_INPUT corrupt: still routes to postAction (TOOL_INPUT corruption is orthogonal), and reports the corruption via toolInputCorrupt', () => {
        const { raw, toolInputCorrupt } = buildEnvVarPayload({
          TOOL_NAME: 'Bash',
          TOOL_INPUT: '{"command":"npm test"',   // truncated mid-string
          TOOL_RESPONSE: JSON.stringify({ exit_code: 0 }),
        })
        expect(toolInputCorrupt).toBe(true)

        const call = parsePayload('claude-code', raw)
        expect(call.postAction).toBeDefined()
        expect(call.postAction?.exitCode).toBe(0)
      })

      it('TOOL_RESPONSE="" (defined but empty): stays on the bare pre-tool-call shape, NOT PostToolUse — a wrapper that exports the var unconditionally must not silently disarm blocking', () => {
        const { raw } = buildEnvVarPayload({
          TOOL_NAME: 'Bash',
          TOOL_INPUT: JSON.stringify({ command: 'rm -rf /' }),
          TOOL_RESPONSE: '',
        })
        const call = parsePayload('claude-code', raw)
        expect(call.tool).toBe('Bash')
        expect(call.args).toEqual({ command: 'rm -rf /' })
        expect(call.postAction).toBeUndefined()
      })
    })
  })
})

describe('v1 M2-C1: cline claim-to-evidence (agent_end/TaskComplete, tool_result/PostToolUse)', () => {
  it('agent_end sets `reasoning` from turn.outputText, routing to the claim-reach path', () => {
    const call = parsePayload('cline', JSON.stringify({
      hookName: 'agent_end', taskId: 'task_1',
      turn: { outputText: 'Done, all tests pass.', status: 'completed' },
    }))
    expect(call.reasoning).toBe('Done, all tests pass.')
    expect(call.tool).toBe('assistant-message')
    expect(call.args).toEqual({})
    expect(call.sessionId).toBe('task_1')
    expect(call.postAction).toBeUndefined()
  })

  it('agent_end with a missing/non-string turn.outputText stays on the claim-reach path with empty reasoning, not a fall-through to an ordinary call', () => {
    const call = parsePayload('cline', JSON.stringify({ hookName: 'agent_end', taskId: 'task_2' }))
    expect(call.reasoning).toBe('')
    expect(call.tool).toBe('assistant-message')
    expect(call.degenerate).toBeUndefined()
  })

  it('tool_result sets `postAction` with exitCode ALWAYS null — Cline\'s own `success` field does not confirm a shell command\'s exit status (see hook.ts comment), so this must never guess a pass', () => {
    const call = parsePayload('cline', JSON.stringify({
      hookName: 'tool_result', taskId: 'task_3',
      postToolUse: { toolName: 'bash', parameters: { command: 'npm test' }, result: 'FAIL 3 tests', success: false, executionTimeMs: 40 },
    }))
    expect(call.postAction).toEqual({ tool: 'bash', args: { command: 'npm test' }, exitCode: null, outputText: 'FAIL 3 tests' })
    expect(call.reasoning).toBeUndefined()

    // Even when Cline itself reports success:true, exitCode still stays
    // null — the discharge honesty gap is about what `success` CONFIRMS,
    // not about which value it happens to carry.
    const successCall = parsePayload('cline', JSON.stringify({
      hookName: 'tool_result', taskId: 'task_3',
      postToolUse: { toolName: 'bash', parameters: { command: 'npm test' }, result: 'ok', success: true, executionTimeMs: 40 },
    }))
    expect(successCall.postAction?.exitCode).toBeNull()
    expect(successCall.postAction?.outputText).toBe('ok')
  })

  it('an ordinary preToolUse (tool_call) payload is unaffected by the new hookName branches', () => {
    const call = parsePayload('cline', JSON.stringify({
      hookName: 'tool_call', taskId: 'task_4',
      preToolUse: { toolName: 'bash', parameters: { command: 'ls' } },
    }))
    expect(call.tool).toBe('bash')
    expect(call.args).toEqual({ command: 'ls' })
    expect(call.sessionId).toBe('task_4')
    expect(call.postAction).toBeUndefined()
    expect(call.reasoning).toBeUndefined()
  })

  it('sessionId prefers taskId, then sessionContext.rootSessionId, then the pre-existing unconfirmed guesses — never fabricated when none are present', () => {
    expect(parsePayload('cline', JSON.stringify({
      hookName: 'tool_call', taskId: 'task_5', sessionContext: { rootSessionId: 'root_5' },
      preToolUse: { toolName: 'bash', parameters: {} },
    })).sessionId).toBe('task_5')

    expect(parsePayload('cline', JSON.stringify({
      hookName: 'tool_call', sessionContext: { rootSessionId: 'root_6' },
      preToolUse: { toolName: 'bash', parameters: {} },
    })).sessionId).toBe('root_6')

    expect(parsePayload('cline', JSON.stringify({
      preToolUse: { toolName: 'bash', parameters: {}, sessionId: 'legacy_guess_7' },
    })).sessionId).toBe('legacy_guess_7')

    expect(parsePayload('cline', JSON.stringify({
      preToolUse: { toolName: 'bash', parameters: {} },
    })).sessionId).toBeUndefined()
  })
})

describe('v1 M2-C1: cursor claim-to-evidence (afterAgentResponse, postToolUse/postToolUseFailure)', () => {
  it('afterAgentResponse sets `reasoning` from `text` when a token-count field is present, routing to the claim-reach path', () => {
    const call = parsePayload('cursor', JSON.stringify({
      conversation_id: 'conv_1', generation_id: 'gen_1', model: 'gpt-5',
      text: 'Done, all tests pass.', input_tokens: 100, output_tokens: 20,
    }))
    expect(call.reasoning).toBe('Done, all tests pass.')
    expect(call.tool).toBe('assistant-message')
    expect(call.sessionId).toBe('conv_1')
    expect(call.postAction).toBeUndefined()
  })

  it('does NOT route afterAgentThought into the claim-reach path — same {conversation_id, text, duration_ms} shape, but no token-count fields', () => {
    const call = parsePayload('cursor', JSON.stringify({
      conversation_id: 'conv_2', generation_id: 'gen_2', model: 'gpt-5',
      text: 'internal reasoning, not the final answer', duration_ms: 12,
    }))
    expect(call.reasoning).toBeUndefined()
    // Falls through to the tool_name/command-shaped branches, which find
    // neither here — this is the pre-existing "unknown tool" MCP shape,
    // not a crash. The point of this test is only that `text` alone never
    // triggers the claim-reach path.
    expect(call.tool).toBe('unknown')
  })

  it('postToolUse (shell): parses exitCode out of the JSON-stringified tool_output, matching Cursor\'s own createSuccessOutput({output, exitCode}) shape', () => {
    const pass = parsePayload('cursor', JSON.stringify({
      conversation_id: 'conv_3', tool_name: 'bash', tool_input: { command: 'npm test' },
      tool_output: JSON.stringify({ output: 'ok', exitCode: 0 }), duration: 500, tool_use_id: 'tu_1',
    }))
    expect(pass.postAction).toEqual({ tool: 'bash', args: { command: 'npm test' }, exitCode: 0, outputText: 'ok' })

    const fail = parsePayload('cursor', JSON.stringify({
      conversation_id: 'conv_3', tool_name: 'bash', tool_input: { command: 'npm test' },
      tool_output: JSON.stringify({ output: 'FAIL', exitCode: 1 }), duration: 500, tool_use_id: 'tu_2',
    }))
    expect(fail.postAction).toEqual({ tool: 'bash', args: { command: 'npm test' }, exitCode: 1, outputText: 'FAIL' })
  })

  it('postToolUse (non-shell): exitCode stays null when tool_output carries no numeric exitCode field — absence is normal for e.g. a file read, not a parse failure', () => {
    const call = parsePayload('cursor', JSON.stringify({
      conversation_id: 'conv_4', tool_name: 'read_file', tool_input: { path: 'a.ts' },
      tool_output: JSON.stringify({ file_path: 'a.ts', content_length: 42 }), duration: 10, tool_use_id: 'tu_3',
    }))
    expect(call.postAction?.exitCode).toBeNull()
    expect(call.postAction?.tool).toBe('read_file')
  })

  it('postToolUseFailure: exitCode 1 (a confirmed infra-level failure — spawn error/timeout/abort, per Cursor\'s own isSuccess semantics), outputText from error_message', () => {
    const call = parsePayload('cursor', JSON.stringify({
      conversation_id: 'conv_5', tool_name: 'bash', tool_input: { command: 'sleep 999' },
      error_message: 'Command timed out after 60000ms', failure_type: 'timeout', duration: 60000,
    }))
    expect(call.postAction).toEqual({
      tool: 'bash', args: { command: 'sleep 999' }, exitCode: 1, outputText: 'Command timed out after 60000ms',
    })
  })

  it('beforeShellExecution/beforeMCPExecution are unaffected by the new branches', () => {
    const shell = parsePayload('cursor', JSON.stringify({ command: 'ls', conversation_id: 'conv_6' }))
    expect(shell.tool).toBe('bash')
    expect(shell.postAction).toBeUndefined()
    expect(shell.reasoning).toBeUndefined()

    const mcp = parsePayload('cursor', JSON.stringify({ tool_name: 'search', tool_input: {}, conversation_id: 'conv_7' }))
    expect(mcp.tool).toBe('search')
    expect(mcp.postAction).toBeUndefined()
  })
})

describe('verdict rendering per host', () => {
  it('preserves a message containing quotes — the sed bug', () => {
    const message = 'Use "--force-with-lease" instead of --force.'

    const cursor = JSON.parse(renderVerdict('cursor', verdict()).stdout)
    expect(cursor.permission).toBe('deny')
    expect(cursor.userMessage).toContain(message)

    const cline = renderVerdict('cline', verdict()).stdout
    const control = JSON.parse(cline.replace(/^HOOK_CONTROL\t/, ''))
    expect(control.cancel).toBe(true)
    expect(control.errorMessage).toContain(message)

    for (const host of ['codex', 'claude-code'] as const) {
      expect(renderVerdict(host, verdict()).stderr).toContain(message)
    }
  })

  it('preserves newlines, backticks and non-ASCII', () => {
    // The real no-push-to-main message has an em dash, an arrow and
    // backticks around the `keel allow` command.
    const message = 'Pushing directly to a protected branch — approval required.\n   → run `keel allow no-push-to-main --once`'
    const v = verdict({ action: 'prompt', rule_id: 'no-push-to-main', message })

    const cursor = JSON.parse(renderVerdict('cursor', v).stdout)
    expect(cursor.userMessage).toContain('→')
    expect(cursor.userMessage).toContain('`keel allow no-push-to-main --once`')

    const control = JSON.parse(renderVerdict('cline', v).stdout.replace(/^HOOK_CONTROL\t/, ''))
    expect(control.errorMessage).toContain('—')
  })

  it('blocks on every blocking verdict and stays out of the way otherwise', () => {
    for (const host of HOSTS) {
      for (const action of ['deny', 'block', 'prompt', 'redirect', 'research'] as const) {
        expect(renderVerdict(host, verdict({ action })).blocked).toBe(true)
      }
      for (const action of ['allow', 'warn', 'report'] as const) {
        expect(renderVerdict(host, verdict({ action })).blocked).toBe(false)
      }
    }
  })

  it('routes prompt to Cursor’s own approval UI, not a hard deny', () => {
    const cursor = JSON.parse(renderVerdict('cursor', verdict({ action: 'prompt' })).stdout)
    expect(cursor.permission).toBe('ask')
  })

  it('emits the exit code each host actually blocks on', () => {
    // Codex treats exit 2 as "blocked" and every OTHER non-zero as "the
    // hook failed, continue" — so the code matters, not just non-zero.
    expect(renderVerdict('codex', verdict()).exitCode).toBe(2)
    expect(renderVerdict('claude-code', verdict()).exitCode).toBe(2)
    // Cline and Cursor signal through stdout and must exit 0.
    expect(renderVerdict('cline', verdict()).exitCode).toBe(0)
    expect(renderVerdict('cursor', verdict()).exitCode).toBe(0)
  })

  it('supports gemini, which uses the Claude Code hook shape', () => {
    // `gemini hooks migrate --from-claude` exists and advertises that
    // equivalence, so the adapter is Claude-Code-shaped by construction.
    expect(HOSTS).toContain('gemini')

    expect(parsePayload('gemini', JSON.stringify({
      tool_name: 'bash', tool_input: { command: 'rm -rf /' },
    }))).toEqual({ tool: 'bash', args: { command: 'rm -rf /' } })

    const blocked = renderVerdict('gemini', verdict())
    expect(blocked.blocked).toBe(true)
    expect(blocked.exitCode).toBe(2)
    // The quote-truncation regression, checked for the new host too.
    expect(blocked.stderr).toContain('Use "--force-with-lease" instead of --force.')

    expect(renderVerdict('gemini', verdict({ action: 'warn' })).exitCode).toBe(0)
  })

  it('fails CLOSED when keel itself could not evaluate', () => {
    for (const host of HOSTS) {
      const failure = renderVerdict(host, null)
      expect(failure.blocked).toBe(true)
      const text = failure.stdout + failure.stderr
      expect(text.toLowerCase()).toContain('keel')
    }
  })
})

describe('session_id extraction (keel allow --session plumbing)', () => {
  // Absence is honest, not a bug: a host whose real session field isn't
  // confirmed (or genuinely omitted from a payload) must not fabricate one
  // — evaluateToolCall falls back to a fresh per-process id, which simply
  // cannot participate in a `keel allow --session` grant. That is the
  // correct, safe failure mode (never a false match onto some OTHER
  // session), not a defect this suite should paper over.
  it('reads session_id off the Claude-Code-shaped payload (claude-code, gemini, codex)', () => {
    for (const host of ['claude-code', 'gemini', 'codex'] as const) {
      const call = parsePayload(host, JSON.stringify({
        tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'ses_abc123',
      }))
      expect(call.sessionId).toBe('ses_abc123')
    }
  })

  it('reads conversation_id off the Cursor payload, for either shell or MCP shape', () => {
    const shell = parsePayload('cursor', JSON.stringify({ command: 'ls', conversation_id: 'conv_1' }))
    expect(shell.sessionId).toBe('conv_1')

    const mcp = parsePayload('cursor', JSON.stringify({
      tool_name: 'search', tool_input: {}, conversation_id: 'conv_2',
    }))
    expect(mcp.sessionId).toBe('conv_2')
  })

  it('reads a generic session_id when present, without requiring one', () => {
    const withId = parsePayload('generic', JSON.stringify({ tool: 'bash', args: {}, session_id: 'g1' }))
    expect(withId.sessionId).toBe('g1')

    const withoutId = parsePayload('generic', JSON.stringify({ tool: 'bash', args: {} }))
    expect(withoutId.sessionId).toBeUndefined()
  })

  it('carries no session_id when a payload has none, rather than inventing one', () => {
    for (const host of HOSTS) {
      const call = parsePayload(host, JSON.stringify({ tool_name: 'Bash', tool_input: {}, command: 'ls' }))
      expect(call.sessionId).toBeUndefined()
    }
  })
})

describe('warn-visibility per host', () => {
  // The verdict rendered for a non-blocking result whose message must
  // reach a human-or-model-visible field, not stderr-on-exit-0 — proven
  // invisible for the exit-code hosts (see the long comment in hook.ts
  // above renderVerdict's `!blocked` branch, and
  // session/EVIDENCE/wave3-warnsurface.md for the citations).
  const warned = verdict({ action: 'warn', rule_id: 'no-destructive-commands', message: 'First violation — warning only.' })

  it('claude-code: systemMessage (user) AND hookSpecificOutput.additionalContext (model), never bare stderr', () => {
    const v = renderVerdict('claude-code', warned)
    expect(v.exitCode).toBe(0)
    expect(v.stderr).toBe('')     // exit-0 stderr is the confirmed-invisible channel
    const payload = JSON.parse(v.stdout)
    expect(payload.systemMessage).toContain('no-destructive-commands')
    expect(payload.systemMessage).toContain('First violation')
    expect(payload.hookSpecificOutput.additionalContext).toContain('First violation')
  })

  it('claude-code/gemini: a warn NEVER sets permissionDecision:allow — that would short-circuit Claude Code\'s own permission prompt and auto-approve the very violation keel is warning about', () => {
    // This is the discriminator: `warn` means "first violation, not yet
    // blocked," not "keel has decided this call is fine." Before this
    // lane, a first-violation warn exited 0 with plain stderr and Claude
    // Code's own permission system still asked the human before e.g.
    // `git commit --no-verify` ran. An explicit `permissionDecision:
    // 'allow'` would have skipped that ask entirely — trading an invisible
    // warning for a visible-but-auto-approved one, which is a net
    // weakening of the guard this lane exists to strengthen.
    for (const host of ['claude-code', 'gemini'] as const) {
      const payload = JSON.parse(renderVerdict(host, warned).stdout)
      expect(payload.hookSpecificOutput.permissionDecision).toBeUndefined()
    }
  })

  it('gemini: same Claude-Code-shaped envelope', () => {
    const payload = JSON.parse(renderVerdict('gemini', warned).stdout)
    expect(payload.systemMessage).toContain('no-destructive-commands')
    expect(payload.hookSpecificOutput.additionalContext).toContain('no-destructive-commands')
  })

  it('codex: systemMessage only — deliberately omits hookSpecificOutput (see the rejected-permissionDecision citation in hook.ts)', () => {
    const v = renderVerdict('codex', warned)
    expect(v.exitCode).toBe(0)
    expect(v.stderr).toBe('')
    const payload = JSON.parse(v.stdout)
    expect(payload.systemMessage).toContain('no-destructive-commands')
    expect(payload.hookSpecificOutput).toBeUndefined()
  })

  it('cursor: both userMessage/agentMessage (legacy) AND user_message/agent_message (cursor.com/docs/hooks current schema) on the allow response, not stderr', () => {
    // M4 host-breadth: cursor.com/docs/hooks was re-fetched live and
    // confirmed snake_case (`user_message`/`agent_message`) — see hook.ts's
    // comment on this branch for why both spellings are sent additively
    // rather than switching outright (an unrecognized field risks a
    // Codex-#249-shaped "hook failed" fail-open with no live Cursor access
    // to rule that out here).
    const v = renderVerdict('cursor', warned)
    expect(v.stderr).toBe('')
    const payload = JSON.parse(v.stdout)
    expect(payload.permission).toBe('allow')
    expect(payload.userMessage).toContain('no-destructive-commands')
    expect(payload.agentMessage).toContain('no-destructive-commands')
    expect(payload.user_message).toContain('no-destructive-commands')
    expect(payload.agent_message).toContain('no-destructive-commands')
  })

  it('cline: systemMessage on a non-cancelling HOOK_CONTROL line, not stderr', () => {
    const v = renderVerdict('cline', warned)
    expect(v.stderr).toBe('')
    const control = JSON.parse(v.stdout.replace(/^HOOK_CONTROL\t/, ''))
    expect(control.cancel).toBe(false)
    expect(control.systemMessage).toContain('no-destructive-commands')
  })

  it('generic: advisory text on stdout — no named channel is documented, but stdout beats a stderr nobody promised to read either', () => {
    const v = renderVerdict('generic', warned)
    expect(v.stderr).toBe('')
    expect(v.stdout).toContain('no-destructive-commands')
  })

  it('a true allow (no rule_id) stays silent on every host — nothing to warn about', () => {
    const clean = verdict({ action: 'allow', rule_id: null as unknown as string, message: '' })
    for (const host of HOSTS) {
      const v = renderVerdict(host, clean)
      expect(v.blocked).toBe(false)
      expect(v.stderr).toBe('')
      // No advisory text anywhere — stdout is either empty or a bare
      // envelope with no message field carrying content.
      expect(v.stdout).not.toContain('no-destructive-commands')
    }
  })
})
