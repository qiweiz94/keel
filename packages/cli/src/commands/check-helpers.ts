/**
 * Ports of `PolicyEngine.checkPKillPython`/`checkSecret` for `keel check`: the
 * default rules have no `pkill` coverage and never scan a bash command as content.
 * Kept independent of `PolicyEngine` so they outlive its removal from `check.ts`.
 */

/** Mirrors `PolicyEngine.checkPKillPython` exactly. */
export function isPkillPython(cmd: string): boolean {
  return /pkill.*-f.*python/.test(cmd)
}

export interface SecretInCommandResult {
  matched: boolean
  pattern?: string
}

const SECRET_PATTERNS = [
  /(?<![A-Z0-9])(AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/,
  /(?:sk-[a-zA-Z0-9]{32,})/,
  /(?:ghp_[a-zA-Z0-9]{36})/,
  /(?:gho_[a-zA-Z0-9]{36})/,
  /(?:ghu_[a-zA-Z0-9]{36})/,
  /(?:ghs_[a-zA-Z0-9]{36})/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:OPENAI|ANTHROPIC|DEEPSEEK|GITLAB)_(?:API_KEY|SECRET|TOKEN)(?![a-zA-Z0-9_])/,
  /\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)(?![a-zA-Z0-9_])/,
  /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_ACCESS_KEY)(?![a-zA-Z0-9_])/,
]

/** Mirrors `PolicyEngine.checkSecret`'s pattern list exactly, applied to a command string. */
export function checkSecretInCommand(cmd: string): SecretInCommandResult {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(cmd)) {
      return { matched: true, pattern: pattern.source }
    }
  }
  return { matched: false }
}
