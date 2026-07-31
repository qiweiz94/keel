import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const BUILTIN_TEMPLATES: Record<string, string> = {
  'default': `# keel default policy
# Safe defaults for most projects
version: "1.0"
settings:
  default_action: warn
  audit_log: true
command_rules:
  - name: "Block destructive commands"
    patterns:
      - regex: '^rm -rf /'
      - regex: '^rm -rf ~'
      - regex: 'pkill.*-f.*python'
    action: block
    message: "Destructive command blocked."
  - name: "Restrict sudo usage"
    patterns:
      - prefix: "sudo "
    action: block
    message: "Sudo commands blocked by default."
  - name: "Block git hook bypass"
    patterns:
      - regex: 'git.*--no-verify'
      - regex: 'git push --force(?!-with-lease)'
      - regex: "core\\\\.hooksPath"
    action: block
    message: "Git hook bypass is not allowed."
file_rules:
  - name: "Protect secret files"
    paths: ["**/.env", "**/.env.*", "**/credentials*", "**/*.pem", "**/*-key.json"]
    exclude: [".env.example"]
    actions: { read: block, write: block }
    message: "Protected file: use a secrets manager instead."
`,

  'strict': `# keel strict policy
# Maximum protection for sensitive projects
version: "1.0"
settings:
  default_action: block
  audit_log: true
command_rules:
  - name: "Block all dangerous commands"
    patterns:
      - regex: '^rm '
      - regex: '^kill|pkill'
      - regex: '^sudo'
      - regex: '^reboot|shutdown|poweroff'
      - regex: '^dd '
      - regex: '^mkfs|^fdisk|^parted'
    action: block
    message: "Dangerous command blocked by strict policy."
  - name: "Restrict git operations"
    patterns:
      - regex: 'git.*--no-verify'
      - regex: 'git push --force(?!-with-lease)'
      - regex: 'git reset --hard'
      - regex: 'git.*core\\.hooksPath'
      - regex: 'git.*HUSKY=0|git.*LEFTHOOK=0'
    action: block
    message: "Git operation blocked by strict policy."
  - name: "Lock package managers"
    patterns:
      - prefix: "npm "
      - prefix: "pnpm "
      - prefix: "yarn "
    action: prompt
    message: "Package manager action requires approval."
file_rules:
  - name: "Block all secret files"
    paths:
      - "**/.env*"
      - "**/secret*"
      - "**/credential*"
      - "**/*.pem"
      - "**/*.key"
      - "**/*.cert"
      - "**/id_rsa*"
      - "**/id_ed25519*"
      - "**/.npmrc"
      - "**/.git-credentials"
    actions: { read: block, write: block }
    message: "Secret file access blocked by strict policy."
  - name: "Lock config files"
    paths: ["**/.git/config", "**/*.conf", "**/Makefile", "**/Dockerfile"]
    actions: { write: warn }
    message: "Config file changes should be reviewed."
`,

  'minimal': `# keel minimal policy
# Lightweight protection — just the basics
version: "1.0"
settings:
  default_action: warn
  audit_log: true
command_rules:
  - name: "Block truly dangerous commands"
    patterns:
      - regex: '^rm -rf /'
      - regex: '^rm -rf ~'
    action: block
    message: "This command is too dangerous."
  - name: "Block git hook bypass"
    patterns:
      - regex: 'git.*--no-verify'
      - regex: 'git push --force(?!-with-lease)'
    action: block
    message: "Git hook bypass blocked."
file_rules:
  - name: "Protect .env"
    paths: ["**/.env"]
    actions: { read: warn, write: block }
    message: ".env file is protected."
`,

  'security': `# keel security policy
# Focused on preventing security incidents
version: "1.0"
settings:
  default_action: warn
  audit_log: true
command_rules:
  - name: "Block secret exposure"
    patterns:
      - regex: '^echo.*API_KEY'
      - regex: '^echo.*SECRET'
      - regex: '^echo.*TOKEN'
      - regex: '^cat.*\\.env'
      - regex: '^env \| grep.*KEY'
    action: block
    message: "Secret exposure blocked."
  - name: "Block credential exfiltration"
    patterns:
      - regex: 'curl.*Bearer'
      - regex: 'curl.*Authorization'
      - regex: 'wget.*Bearer'
    action: block
    message: "Potential credential exfiltration blocked."
file_rules:
  - name: "Protect all secrets"
    paths: ["**/.env", "**/.env.*", "**/*secret*", "**/*credential*", "**/*.pem", "**/*.key"]
    actions: { read: block, write: block }
    message: "Secret file blocked."
content_rules:
  - name: "Scan for secrets in code"
    patterns:
      - regex: '(?i)(api[_-]?key|secret|token)\\s*[:=]\\s*[''"][^''']+[''']'
    paths: ["src/**/*.*"]
    action: block
    message: "Hardcoded secret detected."
`,
}

export async function templateCommand(
  action: string | undefined,
  options: { name?: string; list?: boolean }
) {
  if (options.list || !action) {
    // List available templates
    console.log(chalk.cyan('\nkeel policy templates:\n'))
    const customDir = join(process.cwd(), '.ai-enforce', 'templates')
    const customTemplates: string[] = []
    if (existsSync(customDir)) {
      for (const f of readdirSync(customDir)) {
        if (f.endsWith('.yaml')) customTemplates.push(f.replace('.yaml', ''))
      }
    }
    for (const [name, _content] of Object.entries(BUILTIN_TEMPLATES)) {
      const desc = name === 'default' ? 'Safe defaults for most projects' :
        name === 'strict' ? 'Maximum protection for sensitive projects' :
        name === 'minimal' ? 'Lightweight — just the basics' :
        'Focused on preventing security incidents'
      console.log(`  ${chalk.green(name)}`)
      console.log(`    ${desc}`)
    }
    for (const name of customTemplates) {
      console.log(`  ${chalk.yellow(name)} (custom)`)
    }
    console.log(chalk.cyan('\nUsage: keel template <name>\n'))
    return
  }

  // Show or apply a template
  const template = BUILTIN_TEMPLATES[action]
  if (!template) {
    // Check custom templates
    const customPath = join(process.cwd(), '.ai-enforce', 'templates', `${action}.yaml`)
    if (existsSync(customPath)) {
      const content = readFileSync(customPath, 'utf-8')
      console.log(chalk.cyan(`\nTemplate: ${action} (custom)\n`))
      console.log(content)
      return
    }
    console.log(chalk.red(`Unknown template: ${action}`))
    console.log('Available: ' + Object.keys(BUILTIN_TEMPLATES).join(', '))
    return
  }

  console.log(chalk.cyan(`\nTemplate: ${action}\n`))
  console.log(template)
}
