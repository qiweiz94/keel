// scripts/thesis-eval/lib/opencode-runner.mjs
//
// Runs `opencode run <prompt> --dir <cwd> --model <model> --format json`
// under a REAL hard timeout (own process group, SIGTERM then SIGKILL —
// mirrors scripts/live-verify/lib/with-timeout.mjs's technique so a
// grandchild the model spawns can't outlive the deadline) and parses the
// NDJSON event stream `--format json` emits.
//
// Probed empirically (2026-08-11, free model opencode/deepseek-v4-flash-free,
// see session/v04/EVIDENCE/phase-2-harness.md): each line is one JSON object
// with a `type` field (`step_start`, `tool_use`, `step_finish`, `text`, ...).
// `tool_use` events carry `part.tool` (e.g. "bash", "read", "write") and
// `part.state.input` / `part.state.metadata` (for bash: `.output`, `.exit`).
// `text` events carry the assistant's own prose in `part.text` — this is the
// ONLY place a false-success claim can be read from without depending on
// keel's own (Phase-1, not-yet-landed) claim detector, and it is available
// for the UNGUARDED arm too, which never has keel installed at all.

import { spawn } from 'node:child_process'

/**
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.prompt
 * @param {string} opts.model
 * @param {number} opts.timeoutMs
 * @param {Record<string,string>} opts.env
 * @returns {Promise<{
 *   exitCode: number, timedOut: boolean, durationMs: number,
 *   rawStdout: string, rawStderr: string, events: any[]
 * }>}
 */
export function runOpenCode({ cwd, prompt, model, timeoutMs, env }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const args = ['run', prompt, '--dir', cwd, '--model', model, '--format', 'json']
    const child = spawn('opencode', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group so a timeout kill reaches grandchildren
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killTimer = null

    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })

    const hardTimer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* group already gone */ }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* already dead */ }
      }, 5000)
    }, timeoutMs)

    child.on('exit', (code, signal) => {
      clearTimeout(hardTimer)
      if (killTimer) clearTimeout(killTimer)
      const durationMs = Date.now() - started
      resolve({
        exitCode: timedOut ? 124 : (code === null ? 128 : code),
        timedOut,
        durationMs,
        rawStdout: stdout,
        rawStderr: stderr,
        events: parseNdjson(stdout),
        spawnError: null,
        signal,
      })
    })

    child.on('error', (err) => {
      clearTimeout(hardTimer)
      resolve({
        exitCode: 127,
        timedOut: false,
        durationMs: Date.now() - started,
        rawStdout: stdout,
        rawStderr: stderr,
        events: [],
        spawnError: err.message,
        signal: null,
      })
    })
  })
}

function parseNdjson(text) {
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { out.push(JSON.parse(trimmed)) } catch { /* skip non-JSON noise on stdout */ }
  }
  return out
}

/**
 * Pull the observable-without-keel signals out of the raw event stream:
 * every bash invocation (command, exit code, output) in call order, and
 * every piece of assistant prose the model produced (for the false-claim
 * grader). Host-native — works identically for the unguarded arm, which
 * never has a keel trace at all.
 */
export function extractObservables(events) {
  const bashCalls = []
  const toolCalls = []
  const textParts = []
  for (const e of events) {
    const part = e && e.part
    if (!part) continue
    if (part.type === 'tool') {
      const state = part.state || {}
      const entry = {
        tool: part.tool,
        input: state.input || {},
        output: state.metadata && 'output' in state.metadata ? state.metadata.output : state.output,
        exit: state.metadata && typeof state.metadata.exit === 'number' ? state.metadata.exit : null,
        timestamp: e.timestamp,
      }
      toolCalls.push(entry)
      if (part.tool === 'bash') bashCalls.push(entry)
    } else if (part.type === 'text' && typeof part.text === 'string') {
      textParts.push(part.text)
    }
  }
  return { bashCalls, toolCalls, textParts, allText: textParts.join('\n') }
}

/**
 * Sum real spend for one run from opencode's own `--format json` stream
 * (M2-B2, item 3 — cost recording for the frontier arm). Empirically
 * confirmed (2026-08-12, probing this exact harness against
 * opencode/deepseek-v4-flash-free — see session/v1/EVIDENCE/m2-b2-bench.md):
 * every `step_finish` event's `part.cost` is a USD figure opencode itself
 * computes from the model's own pricing (0 for a free model, in this
 * probe), and `part.tokens` carries {input,output,reasoning,cache}. This is
 * opencode's own accounting, not a re-derivation from a hardcoded price
 * table, so it stays correct if pricing changes upstream. Returns null
 * fields (not 0) when no step_finish event carried a `cost`/`tokens` field
 * at all, so an absent-metric case is never silently reported as
 * "confirmed zero spend."
 */
export function extractCost(events) {
  let sawCost = false
  let sawTokens = false
  let costUsd = 0
  const tokens = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }
  for (const e of events) {
    const part = e && e.part
    if (!part || e.type !== 'step_finish') continue
    if (typeof part.cost === 'number') { sawCost = true; costUsd += part.cost }
    if (part.tokens) {
      sawTokens = true
      tokens.input += part.tokens.input || 0
      tokens.output += part.tokens.output || 0
      tokens.reasoning += part.tokens.reasoning || 0
      tokens.cache_read += (part.tokens.cache && part.tokens.cache.read) || 0
      tokens.cache_write += (part.tokens.cache && part.tokens.cache.write) || 0
    }
  }
  return { cost_usd: sawCost ? costUsd : null, tokens: sawTokens ? tokens : null }
}
