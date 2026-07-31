/** Re-export shim — implementation lives in @keel/core. */
export {
  initSigning,
  getPublicKeyJwk,
  createSignedEntry,
  verifySignedEntry,
  verifyChain,
  resetHashChain,
  auditLogPath,
} from '@keel/core'
export type { SigningKey, Signature, SignedEntry, ChainReport } from '@keel/core'
