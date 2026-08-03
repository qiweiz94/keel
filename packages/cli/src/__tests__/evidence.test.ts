import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The audit log and action receipts are the tool's evidence trail.
 *
 * Every test here failed before this change, and each for a reason that was
 * invisible at runtime: the chains reset every process, receipt signing threw
 * on every call behind a best-effort catch, and verification could not load a
 * key. Signed-but-unverifiable evidence is indistinguishable from no evidence.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(HERE, '..', '..', 'dist', 'index.js')

let dir: string

function cli(args: string) {
  try {
    return execSync(`node "${CLI}" ${args}`, { encoding: 'utf-8', cwd: dir, timeout: 10000 })
  } catch (err: any) {
    return (err.stdout || '') + (err.stderr || '')
  }
}

const auditLines = () =>
  readFileSync(join(dir, '.keel', 'audit', 'audit.log'), 'utf-8').split('\n').filter(Boolean)
const receiptLines = () =>
  readFileSync(join(dir, '.keel', 'receipts', 'receipts.log'), 'utf-8').split('\n').filter(Boolean)

beforeEach(() => {
  dir = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
  execSync('git init', { cwd: dir })
  cli('init')
  // Three SEPARATE processes — the case an in-memory chain cannot span, and
  // the only case that occurs in real use.
  for (let i = 0; i < 3; i++) cli('check --command "rm -rf /"')
})

afterEach(() => {
  execSync(`rm -rf "${dir}"`)
})

describe('audit log', () => {
  it('chains across separate CLI invocations', () => {
    const entries = auditLines().map((l) => JSON.parse(l))
    expect(entries.length).toBeGreaterThanOrEqual(3)
    // Exactly one genesis entry. Previously every entry was a genesis entry,
    // so nothing linked to anything and no deletion was detectable.
    expect(entries.filter((e) => e.previousEntryHash === null)).toHaveLength(1)
  })

  it('reports an intact chain when untampered', () => {
    expect(cli('verify')).toContain('chain: intact')
  })

  it('detects a deleted entry', () => {
    const lines = auditLines()
    writeFileSync(
      join(dir, '.keel', 'audit', 'audit.log'),
      [lines[0], ...lines.slice(2)].join('\n') + '\n',
      'utf-8'
    )
    expect(cli('verify')).toContain('BROKEN')
  })

  it('does not cry tamper on a pre-upgrade log', () => {
    // Logs written before the chain persisted across processes have
    // previousEntryHash null on EVERY entry. Reporting those as tampered would
    // fire a false alarm on every existing user's untouched log at upgrade —
    // and an evidence tool that cries wolf trains the operator to ignore it.
    const legacy = auditLines()
      .map((l) => {
        const e = JSON.parse(l)
        e.previousEntryHash = null
        delete e.session
        return JSON.stringify(e)
      })
      .join('\n')
    writeFileSync(join(dir, '.keel', 'audit', 'audit.log'), legacy + '\n', 'utf-8')
    const out = cli('verify')
    expect(out).toContain('chain: intact')
    expect(out).not.toContain('BROKEN')
  })

  it('detects a reordered log', () => {
    const lines = auditLines()
    const swapped = [lines[0], lines[2], lines[1], ...lines.slice(3)]
    writeFileSync(join(dir, '.keel', 'audit', 'audit.log'), swapped.join('\n') + '\n', 'utf-8')
    expect(cli('verify')).toContain('BROKEN')
  })

  it('detects an altered entry', () => {
    const lines = auditLines()
    const tampered = JSON.parse(lines[1])
    tampered.action = 'allow'
    writeFileSync(
      join(dir, '.keel', 'audit', 'audit.log'),
      [lines[0], JSON.stringify(tampered), ...lines.slice(2)].join('\n') + '\n',
      'utf-8'
    )
    const out = cli('verify')
    expect(out).toMatch(/BROKEN|invalid/)
  })
})

describe('action receipts', () => {
  it('are actually written', () => {
    // createReceipt used createSign("ed25519"), which throws "Invalid digest"
    // because Ed25519 takes no digest name. audit() swallowed it, so the
    // feature produced zero receipts while appearing to be wired up.
    expect(existsSync(join(dir, '.keel', 'receipts', 'receipts.log'))).toBe(true)
    expect(receiptLines().length).toBeGreaterThanOrEqual(3)
  })

  it('verify against the on-disk key from a fresh process', () => {
    const out = cli('verify')
    expect(out).toMatch(/(\d+)\/\1 valid/)
    expect(out).not.toContain('0/')
  })

  it('chain across separate CLI invocations', () => {
    const receipts = receiptLines().map((l) => JSON.parse(l))
    expect(receipts.filter((r) => r.previous_receipt_hash === null)).toHaveLength(1)
  })

  it('report a tampered receipt as invalid', () => {
    const lines = receiptLines()
    const r = JSON.parse(lines[0])
    r.decision.verdict = 'allow'
    writeFileSync(
      join(dir, '.keel', 'receipts', 'receipts.log'),
      [JSON.stringify(r), ...lines.slice(1)].join('\n') + '\n',
      'utf-8'
    )
    expect(cli('verify')).toContain('INVALID')
  })

  it('rotation keeps old receipts verifiable (archived keys still verify)', () => {
    const home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    try {
      const core = JSON.stringify(join(HERE, '..', '..', '..', 'core', 'dist', 'index.js'))
      const scriptFile = join(home, 'rotate-test.cjs')
      const script = [
        `const { initReceiptKey, createReceipt, rotateReceiptKey, receiptPublicKeyCandidates, verifyReceiptFromJson } = require(${core})`,
        `const fs = require('node:fs')`,
        `const path = require('node:path')`,
        `process.env.HOME = ${JSON.stringify(home)}`,
        `process.chdir(${JSON.stringify(home)})`,
        `delete process.env.KEEL_RECEIPT_KEY`,
        `initReceiptKey()`,
        `const before = receiptPublicKeyCandidates().map(k => k.kid)`,
        `createReceipt('test-agent', 'Bash', { command: 'x' }, 'deny', 'no-force-push', 'default')`,
        `const rotated = rotateReceiptKey()`,
        `if (!rotated.moved.length) throw new Error('rotate moved nothing')`,
        `const lines = fs.readFileSync(path.join(${JSON.stringify(home)}, '.keel', 'receipts', 'receipts.log'), 'utf-8').split('\\n').filter(Boolean)`,
        `const oldReceipt = lines[0]`,
        `const after = receiptPublicKeyCandidates().map(k => k.kid)`,
        `if (!before.every(kid => after.includes(kid))) throw new Error('rotated key not in candidates')`,
        `const check = verifyReceiptFromJson(oldReceipt)`,
        `if (!check.ok) throw new Error('old receipt no longer verifies: ' + JSON.stringify(check))`,
        `console.log('OK rotated-kids', after.length, 'verify', check.ok)`,
      ].join('\n')
      writeFileSync(scriptFile, script, 'utf-8')
      const out = execSync(`node "${scriptFile}"`, { encoding: 'utf-8', timeout: 10000 })
      expect(out).toContain('OK rotated-kids')
    } finally {
      execSync(`rm -rf "${home}"`)
    }
  })
})
