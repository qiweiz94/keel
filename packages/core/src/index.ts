/**
 * @keel/core — the enforcement library.
 *
 * Single source of truth for policy evaluation, evidence trail, and the enforce engine.
 * `keel` (the CLI) and `@keel/mcp-server` are thin consumers.
 *
 * This package used to be a stale fork: the CLI carried its own divergent copy
 * of PolicyEngine, security fixes landed only there, and this package's test
 * suite — the only tests in the repo — exercised code that nothing shipped.
 * Converging them means those tests now cover the engine users actually run.
 */
export {
  PolicyEngine,
  DEFAULT_POLICY,
  DEFAULT_POLICY_YAML,
  SECRET_ENV_PATTERNS,
} from './policy-engine.js'

export {
  initSigning,
  getPublicKeyJwk,
  createSignedEntry,
  verifySignedEntry,
  verifyChain,
  resetHashChain,
  auditLogPath,
} from './signing.js'
export type { SigningKey, Signature, SignedEntry, ChainReport } from './signing.js'

export {
  initReceiptKey,
  createReceipt,
  verifyReceipt,
  verifyReceiptFromJson,
  getReceiptPublicKey,
  receiptsLogPath,
} from './receipts.js'

export type * from './types.js'

// ── Enforce engine ────────────────────────────────────────────────
export * from './enforce/index.js'
