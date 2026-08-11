import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash } from 'node:crypto'
import { createSignedEntry, verifyChain } from '../signing.js'

// This is NOT a compat test for observed_action — signing.ts's SignedEntry
// (the hash-chained trail `keel verify` reads at .keel/audit/audit.log) is a
// completely separate structure from AuditEntry (the unsigned traces at
// ~/.keel/traces/*.jsonl that this task's fix touches). SignedEntry never
// carried observed_action before or after this change, so there is no old
// vs. new shape to reconcile here. This is a plain regression: confirming
// the untouched trail still verifies, run empirically rather than assumed
// from "I didn't edit that file."
describe('signing chain — untouched by the observed_action change', () => {
  afterEach(() => {
    delete process.env.KEEL_SIGNING_KEY_JWK
  })

  it('still verifies an old-shape hash-chained audit.log end to end', () => {
    // Isolate the signing key via env so this never touches ~/.keel — the
    // same mechanism initSigning() checks first, before any disk path.
    const kp = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    })
    const privateJwk = createPrivateKey({ key: kp.privateKey, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' })
    const publicJwk = createPublicKey({ key: kp.publicKey, format: 'der', type: 'spki' }).export({ format: 'jwk' }) as { x: string }
    const kid = createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: publicJwk.x })).digest('base64url')
    const key = { kid, privateKeyJwk: { ...privateJwk, kid }, publicKeyJwk: { ...publicJwk, kid } }
    process.env.KEEL_SIGNING_KEY_JWK = JSON.stringify(key)

    const directory = mkdtempSync(join(tmpdir(), 'keel-signing-chain-'))
    const logPath = join(directory, 'audit.log')
    const session = `sess-${Date.now()}`

    const e1 = createSignedEntry({ action: 'deny', rule_name: 'r1', message: 'm1', tool_name: 't1' }, session)
    writeFileSync(logPath, `${JSON.stringify(e1)}\n`)
    // No entry has ever carried observed_action — confirms this really is
    // the pre-existing shape, not a coincidentally-matching new one.
    expect(JSON.stringify(e1)).not.toContain('observed_action')

    const e2 = createSignedEntry({ action: 'allow', rule_name: 'r2', message: 'm2', tool_name: 't2' }, session)
    writeFileSync(logPath, `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`)

    const report = verifyChain(logPath, key.publicKeyJwk)
    expect(report.entries).toBe(2)
    expect(report.signaturesInvalid).toBe(0)
    expect(report.brokenLinks).toHaveLength(0)
    expect(report.ok).toBe(true)
  })
})
