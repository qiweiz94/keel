import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon, daemonTokenPath, daemonStatePath, daemonCommand } from '../commands/daemon.js'

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
  home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
  project = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
  mkdirSync(join(project, '.keel'), { recursive: true })
  writeFileSync(join(project, '.keel', 'rules.yaml'), RULES, 'utf-8')
  previousHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  execSync(`rm -rf "${home}" "${project}"`)
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
})
