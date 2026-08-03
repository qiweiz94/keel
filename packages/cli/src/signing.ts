/** Re-export shim — implementation lives in @get-keel/core. */
export {
  initSigning,
  getPublicKeyJwk,
  loadPublicKeyJwk,
  createSignedEntry,
  verifySignedEntry,
  verifyChain,
  resetHashChain,
  rotateSigningKey,
  auditLogPath,
} from '@get-keel/core'
export type { SigningKey, Signature, SignedEntry, ChainReport } from '@get-keel/core'
