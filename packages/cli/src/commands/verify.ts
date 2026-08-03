import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import { verifyReceiptFromJson, getReceiptPublicKey, receiptPublicKeyCandidates } from '../receipts.js'
import { verifyChain, loadPublicKeyJwk } from '../signing.js'
import { createReceipt } from '../receipts.js'

export async function verifyCommand(target?: string, options?: { key?: string; receipt?: string; json?: boolean }) {
  const opts = options || {}
  // Single receipt verification
  if (opts.receipt) {
    const publicKey = opts.key ? JSON.parse(readFileSync(opts.key, 'utf-8')) : undefined
    const receiptPath = opts.receipt
    if (!existsSync(receiptPath)) {
      console.log(chalk.red('Receipt file not found: ' + receiptPath))
      return
    }
    const raw = readFileSync(receiptPath, 'utf-8')
    const result = verifyReceiptFromJson(raw, publicKey)
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    console.log(result.ok ? chalk.green('✓ Receipt VERIFIED') : chalk.red('✗ Receipt INVALID: ' + result.reason))
    return
  }

  // Audit log: signatures AND chain linkage. Linkage is the half that detects
  // deleted entries, which signature checks alone cannot.
  const signingKey = loadPublicKeyJwk()
  const chain = verifyChain()
  if (chain.entries > 0) {
    console.log(chalk.cyan(`\nAudit log — ${chain.entries} entries\n`))
    if (!signingKey) {
      console.log(chalk.yellow('  No signing key found (~/.keel/signing-key.json) — signatures cannot be checked.'))
      console.log(chalk.dim('    This log may have been signed on another machine. Use --key <file> to verify.'))
    } else {
      console.log(`  signatures: ${chain.signaturesValid} valid, ${chain.signaturesInvalid} invalid`)
    }
    if (chain.brokenLinks.length === 0) {
      console.log(chalk.green('  chain: intact (no deleted or reordered entries)'))
    } else {
      console.log(chalk.red(`  chain: BROKEN at ${chain.brokenLinks.length} point(s) — entries deleted, reordered or altered`))
      for (const b of chain.brokenLinks.slice(0, 5)) {
        console.log(chalk.red(`    line ${b.index + 1} (${b.id}): expected prev ${String(b.expected).slice(0, 12)}, found ${String(b.found).slice(0, 12)}`))
      }
    }
  }

  // Batch verify all receipts in the default directory
  const receiptsDir = join(process.cwd(), '.keel', 'receipts')
  if (!existsSync(receiptsDir)) {
    console.log(chalk.yellow('No receipts directory found at ' + receiptsDir))
    console.log(chalk.cyan('Run `keel check` to generate receipts.'))
    return
  }

  const logFile = join(receiptsDir, 'receipts.log')
  if (!existsSync(logFile)) {
    console.log(chalk.yellow('No receipts log found.'))
    return
  }

  const lines = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean)
  let valid = 0
  let invalid = 0

  // A missing key is NOT evidence of tampering — it means the receipts were
  // signed elsewhere (or the key was rotated away without --key). Reporting
  // "tampered receipts detected!" for a key problem trains users to ignore
  // the one signal that matters.
  const noKey = receiptPublicKeyCandidates().length === 0
  if (noKey) {
    console.log(chalk.cyan('\nVerifying ' + lines.length + ' receipts...'))
    console.log(chalk.yellow('  No signing key found at ~/.keel/receipt-key.json — cannot verify signatures.'))
    console.log(chalk.dim('    Receipts may be from another machine. Provide the key with --key <file>.'))
    console.log(chalk.dim('    Run `keel status` or `keel receipts rotate` for key management.'))
    return
  }

  console.log(chalk.cyan('\nVerifying ' + lines.length + ' receipts...\n'))

  // Verify every receipt. The previous `slice(-100)` silently left older
  // entries unexamined while printing "100/100 valid" — tampering with the
  // oldest receipt was undetectable and the output read as a clean bill.
  for (const line of lines) {
    const result = verifyReceiptFromJson(line)
    if (result.ok) valid++
    else invalid++
  }

  const totalChecked = lines.length
  console.log(chalk.green(`  ${valid}/${totalChecked} valid`))
  if (invalid > 0) console.log(chalk.red(`  ${invalid}/${totalChecked} INVALID — tampered receipts detected!`))
  const pubKey = getReceiptPublicKey()
  const kid = pubKey ? (pubKey as any).kid : 'unknown'
  console.log(chalk.cyan(`  Public key: ${kid}\n`))
}

/**
 * Generate a signed receipt for an enforcement action.
 * Called by the policy engine during evaluation.
 */
export function generateReceipt(
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
  verdict: string,
  ruleName: string,
  policyName: string
): void {
  try {
    createReceipt(agentId, toolName, args, verdict, ruleName, policyName)
  } catch { /* best-effort */ }
}
