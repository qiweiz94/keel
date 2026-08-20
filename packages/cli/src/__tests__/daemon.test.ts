import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  startDaemon,
  daemonTokenPath,
  daemonStatePath,
  daemonCommand,
  DaemonPortInUseError,
  PIPELINE_CACHE_MAX,
  pipelineCacheSize,
} from '../commands/daemon.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * `keel daemon` — the local enforcement service.
 *
 * One engine, thin clients: /v1/check evaluates the modern EnforcementPipeline
 * (rules.yaml hierarchy, warn-once/deny-repeat escalation), /v1/requirements
 * serves the standing requirements, /v1/health is liveness. The token file is
 * created mode 0600 and gates every endpoint except health.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))

let home: string
let project: string
let previousHome: string | undefined

const RULES = `version: 1
level: balanced
rules:
  - id: demo-deny
    type: command
    match: "demo-token"
    action: deny
    message: "Demo deny rule"
`

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'keel-test-'))
  project = mkdtempSync(join(tmpdir(), 'keel-test-'))
  mkdirSync(join(project, '.keel'), { recursive: true })
  writeFileSync(join(project, '.keel', 'rules.yaml'), RULES, 'utf-8')
  previousHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  rmSafe(home); rmSafe(project)
})

describe('keel daemon', () => {
  it('creates a 0600 token file and serves health', async () => {
    const handle = await startDaemon({})
    try {
      const tokenPath = daemonTokenPath()
      expect(existsSync(tokenPath)).toBe(true)
      expect((statSync(tokenPath).mode & 0o777)).toBe(0o600)
      expect(readFileSync(tokenPath, 'utf-8').trim()).toBe(handle.token)

      const health = await (await fetch(`http://127.0.0.1:${handle.port}/v1/health`)).json()
      expect(health.ok).toBe(true)
      expect(health.service).toBe('keel')
    } finally {
      await handle.close()
    }
  })

  it('rejects /v1/check without the token', async () => {
    const handle = await startDaemon({})
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'Bash', args: { command: 'demo-token' }, cwd: project }),
      })
      expect(res.status).toBe(401)
    } finally {
      await handle.close()
    }
  })

  it('evaluates rules with warn-once/deny-repeat escalation across requests', async () => {
    const handle = await startDaemon({})
    try {
      const body = JSON.stringify({ tool: 'Bash', args: { command: 'demo-token' }, cwd: project, session_id: 'test-1' })
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.token}` }
      const first = await (await fetch(`http://127.0.0.1:${handle.port}/v1/check`, { method: 'POST', headers, body })).json()
      expect(first.action).toBe('warn')
      expect(first.rule_id).toBe('demo-deny')
      const second = await (await fetch(`http://127.0.0.1:${handle.port}/v1/check`, { method: 'POST', headers, body })).json()
      expect(second.action).toBe('deny')
      expect(second.rule_id).toBe('demo-deny')
    } finally {
      await handle.close()
    }
  })

  it('allows actions that match no rule', async () => {
    const handle = await startDaemon({})
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ tool: 'Bash', args: { command: 'echo fine' }, cwd: project, session_id: 'test-2' }),
      })
      const result = await res.json()
      expect(result.action).toBe('allow')
    } finally {
      await handle.close()
    }
  })

  it('serves the standing requirements for prompt injection', async () => {
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'requirements.md'), '# Standing Requirements\n\n- Test requirement\n', 'utf-8')
    const handle = await startDaemon({})
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/requirements?cwd=${project}`, {
        headers: { Authorization: `Bearer ${handle.token}` },
      })
      const body = await res.json()
      expect(body.content).toContain('Test requirement')
    } finally {
      await handle.close()
    }
  })

  it('writes the state file with the running port and pid', async () => {
    const handle = await daemonCommand({ port: 0 })
    try {
      const state = JSON.parse(readFileSync(daemonStatePath(), 'utf-8'))
      expect(typeof state.port).toBe('number')
      expect(state.pid).toBe(process.pid)
      expect(state.port).toBe(handle.port)
    } finally {
      await handle.close()
    }
  })

  it('blocks SSRF targets on /v1/research (422)', async () => {
    const handle = await startDaemon({})
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ url: 'http://127.0.0.1:1/x', session_id: 'ssrf-test' }),
      })
      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.error).toContain('ssrf_blocked')
    } finally {
      await handle.close()
    }
  })

  it('lists an empty research cache and rejects a bad body', async () => {
    const handle = await startDaemon({})
    try {
      const cache = await (await fetch(`http://127.0.0.1:${handle.port}/v1/research/cache?session_id=nobody`, {
        headers: { Authorization: `Bearer ${handle.token}` },
      })).json()
      expect(cache.entries).toEqual([])

      const bad = await fetch(`http://127.0.0.1:${handle.port}/v1/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ session_id: 'x' }),
      })
      expect(bad.status).toBe(400)
    } finally {
      await handle.close()
    }
  })

  it('records outcomes and hypotheses through the ledger endpoints', async () => {
    const handle = await startDaemon({})
    try {
      const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.token}` }
      const outcome = await (await fetch(`http://127.0.0.1:${handle.port}/v1/outcome`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ session_id: 'ledger-1', cwd: project, tool: 'Bash', args: { command: 'demo-token' }, exit_code: 1 }),
      })).json()
      expect(outcome.recorded).toBe(true)

      const hyp = await (await fetch(`http://127.0.0.1:${handle.port}/v1/hypothesis`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ session_id: 'ledger-1', statement: 'Because X, Y fails.' }),
      })).json()
      expect(hyp.hypothesis.statement).toContain('Because')
      expect(hyp.problem_key).toBeTruthy()

      const noStatement = await fetch(`http://127.0.0.1:${handle.port}/v1/hypothesis`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ session_id: 'ledger-2' }),
      })
      expect(noStatement.status).toBe(400)
    } finally {
      await handle.close()
    }
  })
})

describe('keel daemon — second invocation on an occupied port', () => {
  it('rejects with a typed error instead of an unhandled EADDRINUSE crash', async () => {
    const first = await startDaemon({})
    try {
      await expect(startDaemon({ port: first.port })).rejects.toBeInstanceOf(DaemonPortInUseError)
    } finally {
      await first.close()
    }
  })

  it('daemonCommand prints a clean message and exits non-zero instead of crashing', async () => {
    const first = await startDaemon({})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number): never => {
      throw new Error(`__exit_${code}__`)
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(daemonCommand({ port: first.port })).rejects.toThrow('__exit_1__')
      expect(exitSpy).toHaveBeenCalledWith(1)
      const printed = errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
      expect(printed).toContain('already')
      expect(printed).not.toContain('EADDRINUSE')
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      await first.close()
    }
  })
})

describe('keel daemon — pipeline cache is bounded', () => {
  it('evicts old entries instead of growing without limit', async () => {
    const handle = await startDaemon({})
    try {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.token}` }
      const total = PIPELINE_CACHE_MAX + 10
      for (let i = 0; i < total; i++) {
        await fetch(`http://127.0.0.1:${handle.port}/v1/check`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ tool: 'Bash', args: { command: 'echo hi' }, cwd: `/nonexistent/keel-cache-test-${i}`, session_id: 'cache-test' }),
        })
      }
      expect(pipelineCacheSize()).toBeLessThanOrEqual(PIPELINE_CACHE_MAX)
    } finally {
      await handle.close()
    }
  }, 20000)
})

describe('keel daemon — malformed project rules fail closed, not silently', () => {
  const badRules = `version: 1\nlevel: not-a-real-level\nrules: []\n`
  let badProject: string

  beforeEach(() => {
    badProject = mkdtempSync(join(tmpdir(), 'keel-test-'))
    mkdirSync(join(badProject, '.keel'), { recursive: true })
    writeFileSync(join(badProject, '.keel', 'rules.yaml'), badRules, 'utf-8')
  })

  afterEach(() => {
    rmSafe(badProject)
    delete process.env.KEEL_STRICT
  })

  it('falls back to the built-in defaults and logs loudly (mirrors the plugin fallback)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handle = await startDaemon({})
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ tool: 'Bash', args: { command: 'echo hi' }, cwd: badProject, session_id: 'invalid-rules' }),
      })
      expect(res.status).toBe(200)
      const result = await res.json()
      expect(result.action).toBeDefined()
      const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
      expect(logged).toContain('invalid rules')
      expect(logged).toContain('Invalid protection level')
    } finally {
      await handle.close()
      errorSpy.mockRestore()
    }
  })

  it('throws under KEEL_STRICT=1 instead of silently merging broken rules', async () => {
    process.env.KEEL_STRICT = '1'
    const handle = await startDaemon({})
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ tool: 'Bash', args: { command: 'echo hi' }, cwd: badProject, session_id: 'strict-test' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('KEEL_STRICT')
      expect(body.error).toContain('Invalid protection level')
    } finally {
      await handle.close()
    }
  })
})
