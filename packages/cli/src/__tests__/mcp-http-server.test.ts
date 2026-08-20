import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { startHttpServer } from '../mcp/server.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * `keel serve --transport http` — the streamable-HTTP MCP transport.
 *
 * Two fixes covered here:
 *  - It must bind 127.0.0.1 only (matching daemon.ts / dashboard-web.ts),
 *    never every interface.
 *  - Its bearer-token check must be constant-time (secureEqual, shared with
 *    daemon.ts), not a plain `===` string compare.
 */

let home: string
let previousHome: string | undefined
const TOKEN = 'mcp-http-test-token'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'keel-test-'))
  mkdirSync(join(home, '.keel'), { recursive: true })
  writeFileSync(join(home, '.keel', 'daemon-token'), TOKEN + '\n', 'utf-8')
  previousHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  rmSafe(home)
})

function closeServer(server: ReturnType<typeof startHttpServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('keel serve --transport http', () => {
  it('binds 127.0.0.1 only, not every interface', async () => {
    const server = startHttpServer(0)
    try {
      await new Promise((resolve) => server.once('listening', resolve))
      const address = server.address() as AddressInfo
      expect(address.address).toBe('127.0.0.1')
    } finally {
      await closeServer(server)
    }
  })

  it('rejects a request with a mismatched bearer token', async () => {
    const server = startHttpServer(0)
    try {
      await new Promise((resolve) => server.once('listening', resolve))
      const port = (server.address() as AddressInfo).port
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })
      expect(res.status).toBe(401)
    } finally {
      await closeServer(server)
    }
  })

  it('rejects a token of a different length than the real one', async () => {
    // secureEqual short-circuits on length mismatch before the constant-time
    // compare — still a straight 401, not a crash or timing leak.
    const server = startHttpServer(0)
    try {
      await new Promise((resolve) => server.once('listening', resolve))
      const port = (server.address() as AddressInfo).port
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer short' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })
      expect(res.status).toBe(401)
    } finally {
      await closeServer(server)
    }
  })

  it('accepts the matching bearer token via JSON-RPC ping', async () => {
    const server = startHttpServer(0)
    try {
      await new Promise((resolve) => server.once('listening', resolve))
      const port = (server.address() as AddressInfo).port
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.result).toEqual({})
    } finally {
      await closeServer(server)
    }
  })

  it('also accepts the token via the X-Keel-Token header', async () => {
    const server = startHttpServer(0)
    try {
      await new Promise((resolve) => server.once('listening', resolve))
      const port = (server.address() as AddressInfo).port
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Keel-Token': TOKEN },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })
      expect(res.status).toBe(200)
    } finally {
      await closeServer(server)
    }
  })
})
