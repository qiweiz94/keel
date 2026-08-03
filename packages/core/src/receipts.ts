/**
 * Signed Action Receipts — offline-verifiable evidence trail.
 *
 * Every policy decision emits a cryptographically signed receipt that can be
 * verified independently, without access to the original system.
 *
 * Inspired by Pipelock (signed egress receipts), Emilia Protocol (IETF draft),
 * and Assay (bounded-claim evidence). These projects have converged on the
 * same pattern: Ed25519-signed, hash-chained, offline-verifiable evidence.
 *
 * Key properties:
 *   - Ed25519 signed (verifiable with only the public key)
 *   - Hash-chained (each receipt links to the previous)
 *   - Tamper-evident (any modification invalidates the signature)
 *   - Offline-verifiable (no API call needed to verify)
 *   - Public verification endpoint (/.well-known/jwks.json)
 */

import {
  sign, verify, generateKeyPairSync, createPrivateKey, createPublicKey,
  createHash, randomUUID,
} from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ===== Key Management =====
//
// Private keys live OUTSIDE the project tree (~/.keel/), so committing the
// project can never leak them. Receipts (public data) stay in
// <project>/.keel/receipts/. Legacy keys written into the project tree by
// older versions are still READ (so old receipts verify) but never re-written.

let signingKey: { kid: string; privateJwk: object; publicJwk: object } | null = null

function keyPath(): string {
  return join(homedir(), '.keel', 'receipt-key.json')
}

function legacyKeyPath(): string {
  return join(process.cwd(), '.keel', 'receipts', 'receipt-key.json')
}

function archiveDir(): string {
  return join(homedir(), '.keel', 'receipts-archive')
}

function parseKeyFile(filePath: string): { kid: string; privateJwk: object; publicJwk: object } | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
    return parsed && parsed.kid ? parsed : null
  } catch { return null }
}

export function initReceiptKey(): { kid: string; privateJwk: object; publicJwk: object } {
  if (signingKey) return signingKey

  // Try loading existing key from env or disk
  const envKey = process.env.KEEL_RECEIPT_KEY
  if (envKey) {
    try {
      const parsed = JSON.parse(envKey) as { kid: string; privateJwk: object; publicJwk: object }
      if (parsed && parsed.kid) { signingKey = parsed; return parsed }
    } catch { /* fall through */ }
  }

  const loaded = parseKeyFile(keyPath()) || parseKeyFile(legacyKeyPath())
  if (loaded) { signingKey = loaded; return loaded }

  // Generate
  const kp = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const privJwk = createPrivateKey({ key: kp.privateKey, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' })
  const pubJwk = createPublicKey({ key: kp.publicKey, format: 'der', type: 'spki' }).export({ format: 'jwk' })
  const kid = createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: (pubJwk as any).x })).digest('base64url')

  const newKey = { kid, privateJwk: privJwk, publicJwk: { ...pubJwk, kid } }
  signingKey = newKey
  try {
    const dir = join(homedir(), '.keel')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // 0600 — private key; see the same note in signing.ts.
    writeFileSync(keyPath(), JSON.stringify(newKey), { mode: 0o600 })
  } catch { /* best effort */ }

  return signingKey!
}

/**
 * Load a public key WITHOUT generating one (verification must never create
 * keys — a missing key is a diagnostic, not an invitation to forge).
 * Checks: env → current key → rotated archive → legacy project location.
 */
export function loadReceiptPublicKey(): object | null {
  const envKey = process.env.KEEL_RECEIPT_KEY
  if (envKey) {
    try {
      const parsed = JSON.parse(envKey) as { kid: string; privateJwk: object; publicJwk: object }
      if (parsed?.kid) return parsed.publicJwk
    } catch {}
  }
  const current = parseKeyFile(keyPath())
  if (current) return current.publicJwk
  try {
    const archive = join(homedir(), '.keel', 'receipts-archive')
    if (existsSync(archive)) {
      for (const file of readdirSync(archive).sort()) {
        const rotated = parseKeyFile(join(archive, file))
        if (rotated) return rotated.publicJwk
      }
    }
  } catch {}
  return parseKeyFile(legacyKeyPath())?.publicJwk || null
}

export function getReceiptPublicKey(): object | null {
  // Load only — never generates. See loadReceiptPublicKey.
  return loadReceiptPublicKey()
}

/**
 * Rotate the machine's receipt key: archive the current key (so existing
 * receipts still verify) and forget the in-memory copy so the next write
 * generates a fresh one. Legacy project-tree keys are not touched.
 */
export function rotateReceiptKey(): { moved: string[] } {
  const moved: string[] = []
  const current = keyPath()
  if (existsSync(current)) {
    try {
      mkdirSync(archiveDir(), { recursive: true })
      const target = join(archiveDir(), `receipt-key-${Date.now()}.json`)
      renameSync(current, target)
      moved.push(target)
    } catch { /* best effort */ }
  }
  signingKey = null
  return { moved }
}

// ===== Receipt Types =====

export interface ActionReceipt {
  version: string
  id: string
  timestamp: string
  agent_id: string
  /** Which chain this receipt links into; distinct from agent_id. */
  session?: string
  action: { tool: string; args_hash: string }
  decision: { verdict: string; rule_name: string; policy_name: string }
  previous_receipt_hash: string | null
  receipt_hash: string
  signature?: string
}

// ===== Receipt Creation =====

const receiptChain = new Map<string, string | null>()

export function receiptsLogPath(): string {
  return join(process.cwd(), '.keel', 'receipts', 'receipts.log')
}

/** Recover the chain head for `session` from the last receipt on disk. */
function loadReceiptChainHead(session: string): string | null {
  try {
    const lines = readFileSync(receiptsLogPath(), 'utf-8').split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const r = JSON.parse(lines[i])
      // Chains are per-session, and `session` is distinct from `agent_id`
      // (the latter identifies who acted, the former which run-chain the
      // receipt belongs to), so it has to be persisted and matched explicitly.
      if ((r.session ?? 'default') !== session) continue
      return r.receipt_hash ?? null
    }
  } catch { /* no receipts yet — a fresh chain is correct */ }
  return null
}

export function createReceipt(
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
  verdict: string,
  ruleName: string,
  policyName: string,
  sessionName?: string
): ActionReceipt {
  initReceiptKey()
  const session = sessionName || process.env.KEEL_SESSION_ID || 'default'
  // Continue the chain already on disk. Without this the Map starts empty in
  // every one-shot CLI process, so each run wrote previous_receipt_hash=null
  // and the "chain" linked nothing to anything — deleting receipts left no
  // trace. Same defect, same fix, as the audit chain in signing.ts.
  if (!receiptChain.has(session)) receiptChain.set(session, loadReceiptChainHead(session))

  const argsHash = createHash('sha256').update(JSON.stringify(args)).digest('hex')

  const receipt: ActionReceipt = {
    version: 'action-receipt/v1',
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    agent_id: agentId,
    session,
    action: { tool: toolName, args_hash: argsHash },
    decision: { verdict, rule_name: ruleName, policy_name: policyName },
    previous_receipt_hash: receiptChain.get(session)!,
    receipt_hash: '',
  }

  // Compute receipt hash (over all fields except signature and receipt_hash)
  const { receipt_hash: _, signature: _s, ...toHash } = receipt
  receipt.receipt_hash = createHash('sha256').update(JSON.stringify(toHash)).digest('hex')

  // Sign. Ed25519 is a PURE signature scheme: it hashes internally and takes
  // no digest name, so the createSign('ed25519') streaming API throws
  // "Invalid digest". That threw on every call, and audit()'s best-effort
  // catch swallowed it — the receipts feature had never written a receipt.
  // crypto.sign(null, ...) is the correct one-shot form (as signing.ts uses).
  const key = signingKey!
  const privateKey = createPrivateKey({ key: key.privateJwk as any, format: 'jwk' })
  receipt.signature = sign(null, Buffer.from(JSON.stringify(toHash), 'utf8'), privateKey)
    .toString('base64url')

  // Update chain
  receiptChain.set(session, receipt.receipt_hash)

  // Persist
  try {
    const dir = join(process.cwd(), '.keel', 'receipts')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'receipts.log'), JSON.stringify(receipt) + '\n')
  } catch { /* best effort */ }

  return receipt
}

// ===== Receipt Verification =====

/** All public keys keel can verify against: env → current → archive → legacy. */
export function receiptPublicKeyCandidates(): Array<{ kid: string; publicJwk: object }> {
  const keys: Array<{ kid: string; publicJwk: object }> = []
  const envKey = process.env.KEEL_RECEIPT_KEY
  if (envKey) {
    try {
      const parsed = JSON.parse(envKey) as { kid: string; privateJwk: object; publicJwk: object }
      if (parsed?.kid) keys.push({ kid: parsed.kid, publicJwk: parsed.publicJwk })
    } catch {}
  }
  const current = parseKeyFile(keyPath())
  if (current) keys.push({ kid: current.kid, publicJwk: current.publicJwk })
  try {
    const archive = join(homedir(), '.keel', 'receipts-archive')
    if (existsSync(archive)) {
      for (const file of readdirSync(archive).sort()) {
        const rotated = parseKeyFile(join(archive, file))
        if (rotated) keys.push({ kid: rotated.kid, publicJwk: rotated.publicJwk })
      }
    }
  } catch {}
  const legacy = parseKeyFile(legacyKeyPath())
  if (legacy) keys.push({ kid: legacy.kid, publicJwk: legacy.publicJwk })
  return keys
}

export function verifyReceipt(receipt: ActionReceipt, publicKeyJwk?: object): { ok: boolean; reason?: string } {
  const candidates = publicKeyJwk ? [{ kid: 'explicit', publicJwk: publicKeyJwk }] : receiptPublicKeyCandidates()
  if (!candidates.length) return { ok: false, reason: 'No public key available — no key at ~/.keel/receipt-key.json (receipts may be from another machine; verify with --key <file>)' }

  const { signature, receipt_hash, ...toVerify } = receipt

  if (!signature) return { ok: false, reason: 'No signature' }

  // Verify receipt hash integrity
  const expectedHash = createHash('sha256').update(JSON.stringify(toVerify)).digest('hex')
  if (expectedHash !== receipt_hash) {
    return { ok: false, reason: 'Receipt hash mismatch — content has been tampered with' }
  }

  // Verify Ed25519 signature — one-shot form, matching createReceipt above.
  // Try every candidate key: rotated keys must still verify old receipts.
  for (const { publicJwk: key } of candidates) {
    try {
      const publicKey = createPublicKey({ key: key as any, format: 'jwk' })
      const valid = verify(
        null,
        Buffer.from(JSON.stringify(toVerify), 'utf8'),
        publicKey,
        Buffer.from(signature, 'base64url')
      )
      if (valid) return { ok: true }
    } catch { /* try the next key */ }
  }

  return { ok: false, reason: 'Signature invalid — receipt has been tampered with' }
}

export function verifyReceiptFromJson(jsonString: string, publicKeyJwk?: object): { ok: boolean; reason?: string } {
  try {
    const receipt = JSON.parse(jsonString) as ActionReceipt
    return verifyReceipt(receipt, publicKeyJwk)
  } catch (err) {
    return { ok: false, reason: `Parse error: ${err}` }
  }
}
