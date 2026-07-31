/**
 * Ed25519 signing module for tamper-evident audit entries.
 * Based on patterns from DashClaw and Pipelock.
 * Uses Node.js built-in crypto (zero external dependencies).
 */

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  createHash,
  randomUUID,
} from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface SigningKey {
  kid: string
  privateKeyJwk: object
  publicKeyJwk: object
}

export interface Signature {
  alg: 'EdDSA'
  kid: string
  sig: string // base64url-encoded
}

export interface SignedEntry {
  version: string
  id: string
  timestamp: string
  /** Chains are per-session so concurrent agents do not interleave. */
  session?: string
  action: string
  rule_name: string
  message: string
  tool_name?: string
  args?: Record<string, unknown>
  previousEntryHash: string | null
  signature?: Signature
}

let currentKey: SigningKey | null = null
const sessionHashChains = new Map<string, string | null>()

/** Where audit entries land; the chain head is recovered from this file. */
export function auditLogPath(): string {
  return join(process.cwd(), '.ai-enforce', 'audit.log')
}

/**
 * Recover the chain head from the last entry already on disk.
 *
 * This is what makes the hash chain evidence rather than decoration. The CLI
 * is one-shot: process-local state starts empty on every invocation, so every
 * entry was previously written with previousEntryHash=null and no entry ever
 * linked to the one before it. A chain in which nothing links to anything
 * detects no deletion, no reordering and no truncation.
 *
 * Reading the tail once per process restores continuity across runs, which is
 * the only place real tampering happens.
 */
function loadChainHead(session: string): string | null {
  try {
    const raw = readFileSync(auditLogPath(), 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]) as SignedEntry & { session?: string }
      // Chains are per-session; skip entries belonging to other sessions.
      if ((entry.session ?? 'default') !== session) continue
      const { signature: _sig, ...signed } = entry
      return createHash('sha256').update(canonicalizeJson(signed)).digest('hex')
    }
  } catch { /* no log yet, or unreadable — a fresh chain is correct here */ }
  return null
}

export function initSigning(): SigningKey {
  if (currentKey) return currentKey

  // Check for env var override first
  const envKey = process.env.AI_ENFORCE_SIGNING_KEY_JWK
  if (envKey) {
    try {
      const parsed = JSON.parse(envKey) as SigningKey
      currentKey = parsed
      return parsed
    } catch { /* fall through to disk or generate */ }
  }

  // Try loading from disk (persisted across sessions)
  const keyDir = join(process.cwd(), '.ai-enforce')
  const keyPath = join(keyDir, 'signing-key.json')
  if (existsSync(keyPath)) {
    try {
      const stored = JSON.parse(readFileSync(keyPath, 'utf-8')) as SigningKey
      currentKey = stored
      return stored
    } catch { /* fall through to generate */ }
  }

  // Generate a new Ed25519 key pair
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })

  const privateJwk = createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' })
    .export({ format: 'jwk' })
  const publicJwk = createPublicKey({ key: publicKey, format: 'der', type: 'spki' })
    .export({ format: 'jwk' })

  // Compute kid as RFC 7638 JWK thumbprint
  const thumbprintInput = JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: (publicJwk as any).x })
  const kid = createHash('sha256').update(thumbprintInput).digest('base64url')

  currentKey = {
    kid,
    privateKeyJwk: { ...privateJwk, kid } as any,
    publicKeyJwk: { ...publicJwk, kid } as any,
  }

  // Persist to disk so signatures can be verified across sessions
  try {
    if (!existsSync(keyDir)) mkdirSync(keyDir, { recursive: true })
    // 0600: this is a PRIVATE key sitting beside the log it signs. Default
    // permissions (0644 under a typical umask) let any local user read it and
    // forge entries that verify cleanly, which would defeat the whole trail.
    writeFileSync(keyPath, JSON.stringify(currentKey, null, 2), { mode: 0o600 })
  } catch { /* best-effort persistence */ }

  return currentKey
}

export function getPublicKeyJwk(): object {
  if (!currentKey) initSigning()
  return currentKey!.publicKeyJwk
}

function canonicalizeJson(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce((acc, key) => {
        acc[key] = v[key]
        return acc
      }, {} as Record<string, unknown>)
    }
    return v
  })
}

export function createSignedEntry(
  entry: Omit<SignedEntry, 'version' | 'id' | 'signature' | 'previousEntryHash' | 'timestamp'>,
  sessionName?: string
): SignedEntry {
  const key = currentKey || initSigning()
  const session = sessionName || process.env.KEEL_SESSION_ID || 'default'
  // First write in this process continues the chain already on disk.
  if (!sessionHashChains.has(session)) sessionHashChains.set(session, loadChainHead(session))

  const signedEntry: SignedEntry = {
    version: 'audit-entry/v1',
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    session,
    previousEntryHash: sessionHashChains.get(session)!,
    ...entry,
  }

  // Sign the entry (without the signature field)
  const { signature: _, ...toSign } = signedEntry
  const canonical = canonicalizeJson(toSign)
  const input = Buffer.from(canonical, 'utf8')
  const privateKey = createPrivateKey({ key: key.privateKeyJwk as any, format: 'jwk' })
  const sig = sign(null, input, privateKey)

  signedEntry.signature = {
    alg: 'EdDSA',
    kid: key.kid,
    sig: sig.toString('base64url'),
  }

  // Update hash chain (per-session)
  const entryHash = createHash('sha256').update(canonical).digest('hex')
  sessionHashChains.set(session, entryHash)

  return signedEntry
}

export function verifySignedEntry(entry: SignedEntry, publicKeyJwk: object): boolean {
  try {
    const { signature, ...toVerify } = entry
    if (!signature) return false

    const canonical = canonicalizeJson(toVerify)
    const input = Buffer.from(canonical, 'utf8')
    const publicKey = createPublicKey({ key: publicKeyJwk as any, format: 'jwk' })

    return verify(null, input, publicKey, Buffer.from(signature.sig, 'base64url'))
  } catch {
    return false
  }
}

export interface ChainReport {
  entries: number
  signaturesValid: number
  signaturesInvalid: number
  /** Entries whose previousEntryHash does not match the preceding entry. */
  brokenLinks: Array<{ index: number; id: string; expected: string | null; found: string | null }>
  ok: boolean
}

/**
 * Verify the audit log as a chain, not as a bag of independently-signed lines.
 *
 * Checking signatures alone proves each surviving entry is authentic but says
 * nothing about entries that were REMOVED — which is the tampering that
 * matters for an enforcement log. Only linkage detects deletion, truncation
 * and reordering, so this walks previousEntryHash across the whole file.
 */
export function verifyChain(logPath?: string, publicKeyJwk?: object): ChainReport {
  const report: ChainReport = {
    entries: 0, signaturesValid: 0, signaturesInvalid: 0, brokenLinks: [], ok: false,
  }
  let lines: string[]
  try {
    lines = readFileSync(logPath || auditLogPath(), 'utf-8').split('\n').filter(Boolean)
  } catch {
    return report
  }

  const pub = publicKeyJwk || getPublicKeyJwk()
  const prevBySession = new Map<string, string | null>()

  lines.forEach((line, index) => {
    let entry: SignedEntry & { session?: string }
    try {
      entry = JSON.parse(line)
    } catch {
      report.signaturesInvalid++
      return
    }
    report.entries++

    if (verifySignedEntry(entry, pub)) report.signaturesValid++
    else report.signaturesInvalid++

    const session = entry.session ?? 'default'
    const expected = prevBySession.get(session) ?? null

    // A null previousEntryHash marks the start of a chain, not a break.
    //
    // This matters for upgrades: logs written before the chain persisted across
    // processes have previousEntryHash null on EVERY entry, so treating null as
    // a mismatch would report "BROKEN — entries deleted" on an untouched
    // legacy log. A false tampering alarm is worse than none for an evidence
    // tool: it trains the operator to ignore the one signal that matters.
    //
    // Safe, because previousEntryHash is covered by the signature — an attacker
    // cannot null it out to mask a deletion without invalidating that entry,
    // which the signature check above already reports.
    const startsChain = entry.previousEntryHash === null || entry.previousEntryHash === undefined
    if (prevBySession.has(session) && !startsChain && entry.previousEntryHash !== expected) {
      report.brokenLinks.push({
        index, id: entry.id, expected, found: entry.previousEntryHash ?? null,
      })
    }

    const { signature: _sig, ...signed } = entry
    prevBySession.set(session, createHash('sha256').update(canonicalizeJson(signed)).digest('hex'))
  })

  report.ok = report.signaturesInvalid === 0 && report.brokenLinks.length === 0
  return report
}

export function resetHashChain(sessionName?: string): void {
  const session = sessionName || process.env.KEEL_SESSION_ID || 'default'
  sessionHashChains.set(session, null)
}
