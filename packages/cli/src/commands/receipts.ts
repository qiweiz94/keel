import chalk from 'chalk'
import { rotateReceiptKey } from '../receipts.js'
import { rotateSigningKey } from '../signing.js'

/**
 * `keel receipts rotate` — rotate the machine's private keys.
 *
 * The current keys are archived into ~/.keel/receipts-archive/ so existing
 * receipts and audit entries still verify; the next signed action generates
 * fresh keys. Legacy keys inside project trees are never touched.
 */
export async function receiptsCommand(action: string) {
  if (action !== 'rotate') {
    console.log(chalk.red(`  Unknown receipts action: "${action}". Use: rotate`))
    process.exitCode = 1
    return
  }

  const receipt = rotateReceiptKey()
  const signing = rotateSigningKey()

  console.log(chalk.bold.cyan('\n  ⚓ keel receipts rotate'))
  console.log()
  if (receipt.moved.length) {
    console.log(chalk.green(`  ✓ Archived receipt key -> ${receipt.moved[0]}`))
  } else {
    console.log(chalk.dim('  · No receipt key found at ~/.keel/receipt-key.json (nothing to archive)'))
  }
  if (signing.moved.length) {
    console.log(chalk.green(`  ✓ Archived signing key -> ${signing.moved[0]}`))
  } else {
    console.log(chalk.dim('  · No signing key found at ~/.keel/signing-key.json (nothing to archive)'))
  }
  console.log()
  console.log(chalk.dim('  New keys are generated on the next signed action.'))
  console.log(chalk.dim('  Old keys stay readable, so existing receipts and audit entries still verify.'))
  console.log(chalk.dim('  Archived keys live in ~/.keel/receipts-archive/.'))
  console.log()
}
