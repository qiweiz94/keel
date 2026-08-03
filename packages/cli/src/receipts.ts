/** Re-export shim — implementation lives in @get-keel/core. */
export {
  initReceiptKey,
  createReceipt,
  verifyReceipt,
  verifyReceiptFromJson,
  getReceiptPublicKey,
  loadReceiptPublicKey,
  receiptPublicKeyCandidates,
  rotateReceiptKey,
  receiptsLogPath,
} from '@get-keel/core'
