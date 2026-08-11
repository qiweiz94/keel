import { mkdirSync, existsSync, writeFileSync, copyFileSync, readFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'
import { detectSandbox, sandboxSuggestion } from '../core/enforce/sandbox-detector.js'

/**
 * `keel install` — set up Keel enforcement in the environment.
 *
 * Subcommands:
 *   keel install              — create ~/.keel/rules.yaml if missing
 *   keel install --opencode   — wire OpenCode plugin (global: ~/.opencode/plugins/)
 *   keel install --project    — wire OpenCode plugin + rules in current project
 *   keel install --claude-code— wire Claude Code hooks (project: .claude/hooks/)
 *   keel install --all        — everything above
 *
 * The installed plugin is a verbatim copy of templates/keel-enforce.js —
 * the canonical source shared with the @get-keel/opencode-plugin npm package.
 */

export async function findTemplateSource(name: string): Promise<string | null> {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', name),
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates', name),
    join(process.cwd(), 'packages', 'cli', 'templates', name),
    join(process.cwd(), 'templates', name),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

async function findPluginSource(): Promise<string | null> {
  return findTemplateSource('keel-enforce.js')
}

async function findRequirementsSource(): Promise<string | null> {
  return findTemplateSource('requirements.md')
}

export const DEFAULT_RULES_YAML = `# Keel rules — enforced OUTSIDE the agent's context window.
# Evaluated before every tool call, so they cannot be forgotten, overridden,
# or degraded by context rot. Edit freely: this file is yours.
# Docs: https://github.com/qiweiz94/keel#rules
#
# Three tiers (session/EVIDENCE/wave2-rules.md has the full table):
#   TIER 1 protect — level: protect floors. Always active, never softened by
#     the sprint dial, exact high-confidence signatures only.
#   TIER 2 balanced — warn/prompt (deny only for exact-signature high-
#     confidence matches, e.g. literal credential formats).
#   TIER 3 observe — mode: observe. Evaluated and recorded (observed_action
#     on the trace) but never interrupts. Promote to warn/block once
#     'keel retrospective' shows the hit rate is real.
version: 1
level: balanced
rules:
  # ── TIER 1: protect floor ──────────────────────────────────────────
  - id: keel-control-gate
    type: command
    match: "keel (disable|allow|level|enforce|install|uninstall)( |$)|keel rules [^|;&]*--append"
    action: deny
    level: protect
    priority: 100
    category: bypass
    severity: critical
    confidence: high
    mode: block
    rationale: "Same class as CVE-2025-59536/CVE-2026-21852 and the Copilot autoApprove poisoning reports: an agent that can operate its own enforcement controls can disarm itself. keel controls are for the human's own terminal only."
    remediation: "Run keel disable|allow|level|install|rules --append yourself, not through the agent."
    false_positives:
      - "A user pastes their own 'keel level protect' command into the agent's terminal to demonstrate the dial — still blocked; run it in a separate shell."
    message: "keel controls are user-owned — run keel disable|allow|level|install|rules --append in your own terminal, not through the agent."

  - id: no-rules-tampering
    type: filesystem
    paths:
      - "**/.keel/rules.yaml"
      - "**/.keel.local.yaml"
      - "**/.config/keel/rules.yaml"
      - "**/.keel/DISABLED"
      - "**/.opencode/plugins/**"
      - "**/.keel/plugins/**"
      - "**/.claude/settings.json"
      - "**/.claude/settings.local.json"
      - "**/.mcp.json"
      - "**/.vscode/settings.json"
      - "**/.git/hooks/**"
    action: deny
    level: protect
    priority: 90
    category: bypass
    severity: critical
    confidence: high
    mode: block
    rationale: "CVE-2025-59536 and CVE-2026-21852 (host config poisoning) plus the reported Copilot autoApprove class: an agent that edits its own enforcer's rules, or the host's autoApprove/hook config, disarms every other rule in this file. .claude/settings*.json and .mcp.json carry autoApprove/allow lists and MCP server definitions; git hooks are a persistence vector."
    remediation: "Edit these files yourself, outside the agent. If the agent needs a new keel rule, propose it and paste it in yourself."
    false_positives:
      - ".vscode/settings.json is also edited for ordinary editor prefs (formatOnSave, tabSize) unrelated to autoApprove — those legitimate edits are blocked too. Accepted: the file also carries the trust/approval config CVE-2025-59536-class attacks target, and an autonomous agent has little routine reason to touch team editor settings unprompted."
    message: "Modifying keel's own rules, state, or plugin files is blocked."

  - id: no-enforcer-removal
    type: command
    match: "rm[^|;&]*[.]opencode/plugins/|rm[^|;&]*[.]keel/(rules[.]yaml|plugins|DISABLED)"
    action: deny
    level: protect
    priority: 90
    category: bypass
    severity: critical
    confidence: high
    mode: block
    rationale: "Same self-defense requirement as no-rules-tampering (CVE-2025-59536/CVE-2026-21852 class): deleting the enforcer file is equivalent to editing it to no-op."
    remediation: "Uninstall keel yourself with 'keel uninstall' from your own terminal if you no longer want it."
    false_positives:
      - "A genuine 'keel uninstall' run by the human — this rule only blocks the agent's own 'rm', not the CLI's own uninstall code path."
    message: "Removing keel's enforcement files is blocked."

  - id: agent-env-hijack
    type: command
    match: "(?<![A-Za-z])export +(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*) *=.*(>>|>) *[^ ]*([.]bashrc|[.]zshrc|[.]bash_profile|[.]profile|[.]env)(?![A-Za-z])|(?<![A-Za-z])(echo|printf)(?![A-Za-z])[^|;&]*(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*) *=.*(>>|>) *[^ ]*([.]bashrc|[.]zshrc|[.]bash_profile|[.]profile|[.]env|[.]mcp[.]json)(?![A-Za-z])|(?<![A-Za-z])sed +-i[^|;&]*(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*)(?![A-Za-z])|(?<![A-Za-z])tee +-a? *[^ ]*([.]bashrc|[.]zshrc|[.]bash_profile|[.]profile)(?![A-Za-z])[^|;&]*(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*)(?![A-Za-z])"
    action: deny
    level: protect
    priority: 88
    category: escalation
    severity: critical
    confidence: high
    mode: block
    rationale: "CVE-2025-59536 / CVE-2026-21852: redirecting ANTHROPIC_BASE_URL or OPENAI_BASE_URL persists a man-in-the-middle on every future model call; KEEL_* persisted into shell config can quietly reconfigure this tool's own state/search/receipt paths. Scoped to PERSISTED mutation (redirected into rc/config files), not ordinary ephemeral env use."
    remediation: "If you need a custom base URL or KEEL_* var for local testing, export it for the current shell only — do not persist it into rc files or MCP config."
    false_positives:
      - "A legitimate one-off 'KEEL_STATE_DIR=/tmp/x npm test' in a single command is NOT matched (only >>/tee/sed writes into rc or config files trip this) — that ephemeral pattern is exactly what this repo's own test suites use."
    message: "Persisting a mutated ANTHROPIC_BASE_URL, OPENAI_BASE_URL, or KEEL_* variable into shell/config files is blocked — this is the CVE-2025-59536/CVE-2026-21852 host-config-poisoning pattern."

  - id: no-destructive-commands
    type: command
    match: "rm -rf /(?!tmp|var/tmp)|rm -rf ~|rm -rf [.]( |$)|rm -rf [.][.]( |/|$)|rm -rf [.][/](([*])?( |$))|rm -rf [*]( |$)|rm -rf /tmp/[^ ]*[.][.]([/ ]|$)|chmod -R 777 ([/~][^ ]*|[.])( |$)|mkfs[.0-9]*( |$)|mke2fs( |$)|shred( |$)|wipefs( |$)|blkdiscard( |$)|dd if=[^ ]+ of=/dev/[^ ]+|[; ][:][ \t]*[()][ \t]*[()][ \t]*[{][ \t]*[:][ \t]*[|]:&|^[:][ \t]*[()][ \t]*[()][ \t]*[{][ \t]*[:][ \t]*[|]:&"
    action: deny
    level: protect
    priority: 88
    category: destructive
    severity: critical
    confidence: high
    mode: block
    rationale: "Gemini CLI incident (AIID 1178): an agent misread a relative path and deleted files outside the intended directory. Anchored to root/home/cwd-wide wipes and disk-format/overwrite primitives, not ordinary rm."
    remediation: "Delete specific named files/directories inside the project instead of a wildcard/root wipe."
    false_positives:
      - "rm -rf node_modules, rm -rf dist, rm -rf ./build/tmp-* — all allowed by design (do-not-ship guard: no blanket rm -rf block)."
    message: "Destructive commands (including fork bombs) are blocked."

  - id: no-force-push
    type: command
    match: "git ((--no-pager )|(-C [^ ]+ ))*push.*--force(?!-with-lease)( |=|$)|git ((--no-pager )|(-C [^ ]+ ))*push.*(^| )-f( |=|$)"
    action: deny
    level: protect
    priority: 82
    category: destructive
    severity: high
    confidence: high
    mode: block
    rationale: "Force-pushing overwrites remote history other clones may depend on; --force-with-lease is the safe equivalent and costs nothing extra."
    remediation: "Use 'git push --force-with-lease' instead."
    false_positives:
      - "A genuinely solo throwaway branch nobody else has fetched — still blocked; use --force-with-lease there too, it is a strict improvement."
    message: "Use --force-with-lease instead of --force."

  - id: protected-branch-reset
    type: command
    match: "git reset --hard +(origin/)?(main|master)(?![A-Za-z])|git checkout +(origin/)?(main|master)(?![A-Za-z])[^|;&]*(&&|;) *git reset --hard|git switch +(origin/)?(main|master)(?![A-Za-z])[^|;&]*(&&|;) *git reset --hard"
    action: deny
    level: protect
    priority: 88
    category: destructive
    severity: critical
    confidence: high
    mode: block
    rationale: "git reset --hard against main/master discards commit history other clones depend on. Protected branch names are main/master by default — edit this rule's match to add your own (e.g. release/*, develop)."
    remediation: "Reset a local feature branch, or use 'git revert' on a shared branch instead."
    false_positives:
      - "git reset --hard HEAD~1 on a feature branch with no branch name in the command is a known gap — this rule can only see branch names that appear explicitly in the command text, not ambient checkout state."
    message: "git reset --hard against a protected branch (main/master) discards shared history — blocked."

  - id: protected-branch-delete
    type: command
    match: "git push[^|;&]*(--delete|-d) +(origin +)?(main|master)(?![A-Za-z])|git push[^|;&]* :(main|master)(?![A-Za-z])|git branch (-D|--delete) +(main|master)(?![A-Za-z])"
    action: deny
    level: protect
    priority: 88
    category: destructive
    severity: critical
    confidence: high
    mode: block
    rationale: "Deleting main/master (locally or on the remote) is rarely intentional and is far more disruptive than an ordinary feature-branch cleanup. Ordinary branch deletion stays governed by publish-gate (Tier 2 prompt) — this rule is the exact-name escalation for the protected branches specifically."
    remediation: "Delete the feature branch you meant to, not main/master. If main really must be renamed/retired, do it from the git host's own UI."
    false_positives:
      - "git push origin --delete feature/old — not matched; only the exact main/master branch name trips this."
    message: "Deleting the main/master branch (local or remote) is blocked."

  - id: pipe-to-shell
    type: command
    match: "(curl|wget)[^|;&]*[|] *(sudo )*(ba)?sh( |$)|bash <[(](curl|wget)|(?<![A-Za-z])(ba)?sh(?![A-Za-z]) +-c +.*[$][(][^)]*(curl|wget)|(?<![A-Za-z])eval(?![A-Za-z]) +.*[$][(][^)]*(curl|wget)"
    action: deny
    level: protect
    priority: 88
    category: injection
    severity: critical
    confidence: high
    mode: block
    rationale: "Piping a remote script straight into a shell interpreter executes arbitrary code with no review step — the same trust-the-download pattern behind slopsquatting-class attacks (USENIX 2025) where a downloaded artifact is executed sight-unseen. Extended beyond a literal pipe to bash -c $(curl ...) and eval $(curl ...), the quoted command-substitution variants of the same primitive."
    remediation: "Download the script, read it, then run it explicitly (or use the project/package manager's own install command)."
    false_positives:
      - "curl -O https://example.com/file.tar.gz (download only, no pipe to a shell) is allowed — only piping/substituting into bash/sh/eval trips this."
      - "A script literally named 'flash.sh' or 'wash.sh' run directly ('./wash.sh') is not matched — the pattern requires curl/wget piped or substituted INTO the interpreter, not any filename ending in sh."
    message: "Piping or substituting a remote script into a shell executes arbitrary code — blocked."

  - id: no-exfil-flow
    type: flow
    sources:
      - "**/.env*"
      - "**/.ssh/**"
      - "**/*.pem"
      - "**/.git-credentials"
      - "**/.aws/credentials"
      - "**/.config/gcloud/**"
      - "**/Library/Keychains/**"
      - "**/.npmrc"
      - "**/.netrc"
    sinks: [network]
    action: deny
    level: protect
    priority: 85
    category: exfil
    severity: critical
    confidence: high
    mode: block
    rationale: "The 'lethal trifecta' (private data + untrusted content + an exfiltration path, Simon Willison): once an agent has read a credential file, sending anything to the network in the same flow is the exfil step, regardless of which network tool does it. Extended source list per Tier-1 scope: AWS/gcloud creds, keychain, npmrc, netrc, joining the existing .env/.ssh/.pem/.git-credentials set."
    remediation: "If the agent needs to send config to a service, use a scoped, non-secret value — never a credential file's raw contents."
    false_positives:
      - "rsync of a previously-read .env file is a KNOWN gap, not a false positive of this rule: rsync is not in the sink verb list yet (see fixture-harness.test.ts's documented probe) — a real coverage gap to close in a future wave, not something this rule claims to catch today."
    message: "Data read from sensitive files must not be sent over the network."

  - id: prod-db-destruction
    type: command
    match: "(?=.*(?<![A-Za-z])(prod|production|live)(?![A-Za-z]))(?=.*(psql|mysql|sqlite3|mariadb|pg_restore|cockroach)(?![A-Za-z]))(?=.*(DROP TABLE|TRUNCATE(?![A-Za-z])|DROP DATABASE))(psql|mysql|sqlite3|mariadb|pg_restore|cockroach|.)"
    action: deny
    level: protect
    priority: 86
    category: destructive
    severity: critical
    confidence: high
    mode: block
    rationale: "Replit incident (AIID 1152): an agent ran a destructive SQL statement against the production database mid-task. Scoped to commands where the connection/command text is ALSO tagged prod|production|live (env var, hostname, or database name) — untagged destructive SQL is the separate Tier-2 warn rule (no-db-destructive), per the same incident: the DB there was untagged, so silent enforcement there is wrong and interruption there is also wrong; only the tagged case is a clean protect-floor signal."
    remediation: "Never run DROP/TRUNCATE against a production-tagged connection from an agent session. Use a migration tool with review, or do it yourself outside the agent."
    false_positives:
      - "A staging database whose hostname happens to contain 'live-preview' — a realistic near-miss; scope this rule's word list to your own naming convention if it fires on non-production infrastructure."
    message: "Destructive database operation against a production-tagged connection — blocked."

  # ── TIER 2: balanced (warn / prompt; exact-signature deny kept where already high-confidence) ──
  - id: no-db-destructive
    type: command
    match: "(psql|mysql|sqlite3|mariadb|pg_restore|cockroach)( |$)[^|;&]*(DROP TABLE|TRUNCATE( |$)|DROP DATABASE|DELETE FROM)"
    action: warn
    level: sprint
    priority: 75
    category: destructive
    severity: high
    confidence: medium
    mode: warn
    rationale: "Replit incident (AIID 1152): the production database there was untagged, so a rule that only fires on tagged connections (prod-db-destruction, Tier 1) would have missed it. This is the deliberately-softer catch-all for destructive SQL with NO production tag detected — warn, not deny, because most local/dev database resets are exactly this shape and a hard block here would be the tautological-gate failure mode."
    remediation: "Confirm which database this command targets before running it. If it is production, stop and tag it — prod-db-destruction (Tier 1) will then block it outright."
    false_positives:
      - "sqlite3 ./test.db 'DROP TABLE fixture_users' in a test setup script — a real, common, benign hit; that is why this is warn, not deny."
    message: "Destructive database operation on an untagged connection — verify this is not production."

  - id: no-push-to-main
    type: command
    match: "git push( [^ ]+){0,3} (main|master)( |$)|git push.*[:](main|master)( |$)"
    action: prompt
    level: sprint
    priority: 80
    category: workflow
    severity: high
    confidence: high
    mode: block
    rationale: "Pushing directly to a protected branch skips whatever review process the branch is meant to enforce."
    remediation: "Open a PR instead, or get explicit approval before pushing straight to main."
    false_positives:
      - "A one-person repo with no branch protection configured — still prompts; the human can approve it in one keystroke."
    message: "Pushing directly to a protected branch — approval required."

  - id: commit-to-main
    type: command
    match: "git checkout +(main|master)(?![A-Za-z])[^|;&]*(&&|;) *git commit|git switch +(main|master)(?![A-Za-z])[^|;&]*(&&|;) *git commit"
    action: warn
    level: sprint
    priority: 60
    category: workflow
    severity: medium
    confidence: medium
    mode: warn
    rationale: "Committing directly to main bypasses branch-based review even before the push step no-push-to-main gates. KNOWN GAP: command-type rules see only the literal command text, not ambient git state — a bare 'git commit' while already checked out on main (no checkout/switch in the same command) is invisible to this rule. Only the common one-shot agent pattern (checkout main && commit) is caught."
    remediation: "Create a feature branch before committing: git checkout -b <branch> && git commit."
    false_positives:
      - "git checkout -b feature/x && git commit — not matched, only literal main/master checkouts trip this."
    message: "Committing directly on main/master — consider a feature branch instead."

  - id: no-verify-bypass
    type: command
    match: "git ((--no-pager )|(-C [^ ]+ ))*(commit|push|merge)(( [^ ]+))*? --no-verify( |$)|git ((--no-pager )|(-C [^ ]+ ))*(commit|push|merge)(( [^ ]+))*? -c[ =][^ ]*?core[.]hooksPath(?![/0-9A-Za-z_])|git ((--no-pager )|(-C [^ ]+ ))*-c[ =][^ ]*?core[.]hooksPath(?![/0-9A-Za-z_])|git commit( [^ ]+)* -n( |$)"
    action: warn
    level: sprint
    priority: 70
    category: bypass
    severity: high
    confidence: high
    mode: warn
    rationale: "SOFTENED deny->warn per do-not-ship guard: --no-verify must never hard-deny (a legitimate emergency hotfix, or a hook that is itself broken, needs an escape hatch). Kept exact-signature (real --no-verify/-n/core.hooksPath usage), just no longer irreversible."
    remediation: "Fix the failing hook instead of bypassing it, or explain why the bypass is necessary."
    false_positives:
      - "A genuinely broken pre-commit hook (e.g. a stale cached dependency) where --no-verify is the correct unblock — now a warn, not a hard stop."
    message: "Bypassing git hooks with --no-verify, -n, or core.hooksPath — make sure this is intentional."

  - id: write-outside-project
    type: filesystem
    paths:
      - "/etc/**"
      - "/usr/**"
      - "/bin/**"
      - "/sbin/**"
      - "/System/**"
      - "/Library/**"
      - "**/.bashrc"
      - "**/.zshrc"
      - "**/.bash_profile"
      - "**/.profile"
    action: prompt
    level: sprint
    priority: 65
    category: escalation
    severity: high
    confidence: medium
    mode: block
    rationale: "Gemini CLI incident (AIID 1178): an agent wrote/deleted files outside the directory it believed it was in. Scoped to concrete absolute system paths and shell rc files, NOT a project-relative denylist — a '!'-negated allowlist-by-exclusion pattern was considered and rejected (see session/EVIDENCE/wave2-rules.md): it would invert into matching nearly every ordinary in-project write."
    remediation: "Write inside the project directory. If a system file genuinely needs editing, do it yourself outside the agent."
    false_positives:
      - "A project that happens to be checked out at /usr/local/src/myproject — its own src/ writes are unaffected (paths are matched exactly, not by cwd heuristic), but a write to /usr/local/src/myproject itself would still prompt; document this if your project lives under one of these prefixes."
    message: "Writing outside the project (system path or shell config) — approval required."

  - id: cicd-config-edit
    type: filesystem
    paths:
      - "**/.github/workflows/**"
      - "**/.gitlab-ci.yml"
      - "**/Jenkinsfile"
      - "**/azure-pipelines.yml"
      - "**/.circleci/**"
    action: prompt
    level: sprint
    priority: 65
    category: escalation
    severity: medium
    confidence: high
    mode: block
    rationale: "CI config controls what runs with the repo's stored secrets on every push — an edit here is a higher-blast-radius change than an ordinary source file and deserves a look before it lands."
    remediation: "Review the diff yourself before it merges, same as any other CI change."
    false_positives:
      - "src/workflow-helper.ts or docs/circleci-notes.md — not matched; only files actually inside .github/workflows/, .circleci/, or literally named Jenkinsfile/azure-pipelines.yml/.gitlab-ci.yml trip this."
    message: "Editing CI/CD pipeline configuration — approval required."

  - id: cicd-and-infra
    type: command
    match: "(?<![A-Za-z])terraform +(apply|destroy)(?![A-Za-z])|(?<![A-Za-z])kubectl +[^|;&]*(apply|delete|exec|drain|cordon|rollout +restart)(?![A-Za-z])"
    unless:
      - regex: "--context[= ](docker-desktop|minikube|kind-[a-z0-9-]+|local|orbstack|rancher-desktop|k3d-[a-z0-9-]+)(?![A-Za-z])"
    action: prompt
    level: sprint
    priority: 65
    category: escalation
    severity: high
    confidence: medium
    mode: block
    rationale: "terraform apply/destroy and kubectl mutations can affect real infrastructure outside the repo entirely — the class of blast radius no source-code rule can see. Exempted when --context explicitly names a known local cluster."
    remediation: "Run infra-mutating commands yourself, or review the plan/diff before approving."
    false_positives:
      - "kubectl apply -f local.yaml --context minikube — exempted by the unless clause."
      - "kubectl get pods (a read, not a mutation) — not matched; only apply/delete/exec/drain/cordon/rollout restart trip this."
    message: "Infrastructure-mutating command (terraform apply/destroy or kubectl against a non-exempted context) — approval required."

  - id: secret-file-read-without-egress
    type: command
    match: "(?<![A-Za-z])(cat|less|more|head|tail|strings|xxd|base64)(?![A-Za-z])[^|;&]*( |/)([.]env([.][a-zA-Z]+)?|[.]ssh/(id_rsa|id_ed25519|config)|[.]aws/credentials|[.]npmrc|[.]netrc|[.]pgpass|[.]git-credentials)(?![A-Za-z])"
    action: warn
    level: sprint
    priority: -5
    category: exfil
    severity: medium
    confidence: medium
    mode: warn
    rationale: "The softer sibling of no-exfil-flow (Tier 1): a plain-text read of a secret file with no egress seen YET is informational, not a block — no-exfil-flow (deny) still fires if a network sink follows. KNOWN GAP: filesystem-type rules skip reads by design (pipeline.ts), so this must be command-type — it therefore only sees Bash cat/head/etc reads, never a native Read-tool call on the same path. Priority deliberately set BELOW no-exfil-flow so the flow tracker's read recording always happens first."
    remediation: "If you needed to see the secret file's contents, that's fine — just don't pipe or copy that output anywhere external."
    false_positives:
      - "cat .env.example (an explicitly-example/template file) still matches the .env* pattern — a real FP; narrow the regex further if your project ships many .env.* templates."
    message: "Read of a secret file with no egress detected yet — keep this contained, do not forward it."

  - id: broad-privilege-escalation
    type: command
    match: "(?<![A-Za-z])sudo(?![A-Za-z])(?!.*(?<![A-Za-z])(apt-get|apt|yum|dnf|brew)(?![A-Za-z]))|(?<![A-Za-z])chmod +-R +[0-7]{3,4}(?![A-Za-z0-9])|(?<![A-Za-z])chown +-R(?![A-Za-z])"
    action: warn
    level: sprint
    priority: -5
    category: escalation
    severity: medium
    confidence: low
    mode: warn
    rationale: "Broad recursive permission/ownership changes and unscoped sudo are common in legitimate setup scripts, but are also the shape of a privilege-escalation attempt — warn-level awareness, not a block, given the high legitimate-use rate."
    remediation: "Scope chmod/chown to the specific path that needs it rather than a wide -R; prefer a package manager's own sudo-gated install step over ad-hoc sudo."
    false_positives:
      - "sudo apt-get install build-essential — exempted (common package-manager sudo usage)."
      - "chmod -R 755 ./dist after a build — matches and warns; a real, common, benign hit, which is exactly why this is warn not deny."
    message: "Broad privilege/ownership change (sudo, chmod -R, or chown -R) — double-check the scope."

  - id: paste-site-exfil
    type: command
    match: "(?<![A-Za-z])(curl|wget)(?![A-Za-z])[^|;&]*(pastebin[.]com|hastebin[.][a-z]+|dpaste[.][a-z]+|transfer[.]sh|file[.]io|0x0[.]st)(?![A-Za-z])"
    action: prompt
    level: sprint
    priority: 65
    category: exfil
    severity: high
    confidence: medium
    mode: block
    rationale: "Pastebin-class hosts are a common quick-exfil destination — no legitimate build/test/deploy step in this repo posts there, so a hit is high-signal even without a preceding secret-file read (no-exfil-flow already covers the read-then-network case for the sources it tracks; this covers the destination-based signal on its own)."
    remediation: "Use a proper artifact/log destination, not a public paste site."
    false_positives:
      - "Fetching (not posting to) a public gist or paste link a human shared for context — a GET of such a link is a realistic benign hit; narrow to POST-shaped commands (curl -d/-F/--data) if this fires too often for your workflow."
    message: "Posting to a pastebin-class host — approval required."

  # ── TIER 2: kept as-is (already correctly tiered) ──────────────────
  - id: no-remote-exec
    type: command
    match: "(npx|bunx|npm exec|pipx)( |$)|(pnpm|yarn) dlx( |$)"
    action: prompt
    level: sprint
    priority: 80
    category: escalation
    severity: medium
    confidence: high
    mode: block
    rationale: "On-the-fly package execution downloads and runs code that was never vetted for this project — adjacent to the slopsquatting risk class (USENIX 2025), where a plausible-but-malicious package name gets executed sight-unseen."
    remediation: "Install the package normally (add to package.json, review it), then run it."
    false_positives:
      - "npx tsc --version as a quick version check — still prompts; the approval is one keystroke."
    message: "On-the-fly package execution downloads and runs remote code — approval required."

  - id: no-after-hours-publish
    type: time
    match: "git push|npm publish|gh release create|gh release delete|gh repo delete|gh repo transfer"
    schedule:
      start: "09:00"
      end: "22:00"
    action: warn
    level: sprint
    priority: 0
    category: workflow
    severity: low
    confidence: medium
    mode: warn
    rationale: "A publish/push outside normal hours is often correct (a fix for an active incident) but is also the shape of an unattended overnight run going further than intended — a nudge to double check, not a block."
    remediation: "Confirm this release/push is intentional before proceeding."
    false_positives:
      - "A legitimate on-call engineer shipping a 2am hotfix — warns, does not block."
    message: "Publishing or pushing outside 09:00-22:00 — double-check the release is intentional."

  - id: bash-rate-limit
    type: rate
    match: "Bash"
    window_seconds: 60
    max_calls: 30
    action: warn
    level: sprint
    priority: 0
    category: resource
    severity: low
    confidence: medium
    mode: warn
    rationale: "More than 30 Bash calls in 60 seconds is the clearest cheap signal of a runaway loop the model itself cannot see from inside its own context."
    remediation: "Slow down; if this is legitimately a batch operation, that's fine — this only warns."
    false_positives:
      - "A legitimate loop running one command per file across 40 files in a minute — a real, common, benign hit; warn only, by design."
    message: "More than 30 Bash calls in 60 seconds — possible runaway loop. Slow down."

  - id: no-skip-tests
    type: command
    match: "(npm|pnpm|yarn)( run)? test[^|;&]*--(passWithNoTests|skipTests|no-run)( |$)"
    action: warn
    level: sprint
    priority: 70
    category: bypass
    severity: high
    confidence: high
    mode: warn
    rationale: "SOFTENED deny->warn per do-not-ship guard (no hard test-before-commit / no deny on test-skip flags): a green run with --passWithNoTests etc. is not verification, but there are legitimate uses (an intentionally empty test dir during scaffolding) — this stays visible without blocking."
    remediation: "Run the real suite, or explain why there is nothing to test yet."
    false_positives:
      - "A brand-new package with no tests written yet, using --passWithNoTests during initial scaffolding — a real, common, legitimate hit."
    message: "Faking a green test run is not verification — run the suite."

  - id: no-secrets-in-code
    type: content
    patterns:
      - regex: "AKIA[0-9A-Z]{16}"
      - regex: "ghp_[A-Za-z0-9]{36}"
      - regex: "github_pat_[A-Za-z0-9_]{22,}"
      - regex: "xox[baprs]-[A-Za-z0-9-]{10,}"
      - regex: "sk-[A-Za-z0-9_-]{24,}"
      - regex: "BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY"
      - regex: "-----BEGIN PRIVATE KEY-----"
      - regex: "aws_secret_access_key[\t ]*[:=]"
    action: deny
    level: sprint
    priority: 75
    category: exfil
    severity: critical
    confidence: high
    mode: block
    rationale: "Exact-signature literal credential formats (AWS keys, GitHub tokens, Slack tokens, OpenAI-shaped keys, PEM headers) — high enough confidence to deny at balanced per the severity x confidence rule, despite living in Tier 2."
    remediation: "Use environment variables or a secrets manager, never a literal credential in source."
    false_positives:
      - "A docs page showing a REDACTED example key with the real characters replaced by x's does not match these exact-length formats, so it passes; a real (even if revoked) key literal will still match and deny, which is intentional."
    message: "Hardcoded credentials must not be written to files."

  - id: no-secret-files
    type: filesystem
    paths:
      - "**/.env*"
      - "**/.npmrc"
      - "**/.git-credentials"
      - "**/.netrc"
      - "**/.pgpass"
      - "**/*.pem"
      - "**/*.pfx"
      - "**/*.p12"
      - "**/.ssh/**"
      - "**/id_rsa*"
      - "**/id_ed25519*"
    exclude:
      - "**/.env.example"
      - "**/.env.sample"
      - "**/.env.test"
    action: deny
    level: sprint
    priority: 75
    category: exfil
    severity: high
    confidence: high
    mode: block
    rationale: "Writing/overwriting a credential file is an exact-signature, high-confidence path match with an explicit exclude list for the common template-file exceptions."
    remediation: "Write to a non-credential path, or use the excluded .env.example/.env.sample/.env.test naming for templates."
    false_positives:
      - "A .env.production file used for real deployment config (not matched by the exclude list) still denies, correctly."
    message: "Writing or modifying credential files is blocked."

  - id: no-credential-echo
    type: env
    vars:
      - AWS_SECRET_ACCESS_KEY
      - AWS_ACCESS_KEY_ID
      - GITHUB_TOKEN
      - NPM_TOKEN
      - NODE_AUTH_TOKEN
      - OPENAI_API_KEY
      - ANTHROPIC_API_KEY
      - CLOUDFLARE_API_TOKEN
    action: deny
    level: sprint
    priority: 75
    category: exfil
    severity: high
    confidence: high
    mode: block
    rationale: "An exact named-variable match against a fixed, short, high-confidence list of known secret-bearing env var names."
    remediation: "Reference the variable indirectly (a config loader), don't echo/print it in a command."
    false_positives:
      - "echo $GITHUB_TOKEN_EXPIRY_DAYS is not matched (the var list requires the exact name, not a substring) — see the word-boundary sweep probes in fixture-harness.test.ts."
    message: "Exposing environment credentials in commands is blocked."

  - id: must-sign-commits
    type: command
    match: "git commit(?!.*--signoff)"
    action: fix
    fix:
      - pattern: "git commit"
        replace: "git commit --signoff"
    level: sprint
    priority: 60
    category: workflow
    severity: low
    confidence: high
    mode: block
    rationale: "Auto-adding --signoff is a pure convenience fix, not a security control — no incident citation applies; this is a standing repo convention."
    remediation: "N/A — this rule fixes the command in place automatically."
    false_positives:
      - "git commit --amend --no-edit already has other flags but no --signoff — still auto-fixed, which is the intended behavior."
    message: "Auto-adding --signoff to commits."

  - id: git-history-rewrite
    type: command
    match: "git filter-branch|git rebase|git reset (--hard|--soft|--keep|--merge|HEAD~)|git commit --amend|git stash (drop|clear)"
    action: prompt
    level: sprint
    priority: 80
    category: destructive
    severity: medium
    confidence: high
    mode: block
    rationale: "General git-history-mutation best practice — no single named incident in the provided list; shared-history rewrites are a standing engineering risk regardless of AI involvement."
    remediation: "Confirm nobody else has the commits you are about to rewrite before proceeding."
    false_positives:
      - "git rebase on a local-only feature branch nobody has fetched — still prompts; approval is one keystroke."
    message: "Git history mutation — this rewrites shared history. Approval required."

  - id: publish-gate
    type: command
    match: "npm publish|npm unpublish|gh release create|gh release delete|gh repo delete|gh repo transfer|git push.*[ \t](--delete|-d)( |$)"
    action: prompt
    level: sprint
    priority: 80
    category: workflow
    severity: high
    confidence: high
    mode: block
    rationale: "Publishing or deleting a registry/repo artifact is often irreversible or hard to undo — a standing best practice, no single incident citation applies."
    remediation: "Double-check the version/target before approving."
    false_positives:
      - "git push origin --delete feature/stale-branch — an entirely routine cleanup; still prompts (the narrower Tier-1 protected-branch-delete only fires for main/master specifically)."
    message: "Publishing or deleting registry artifacts — approval required."

  - id: verify-format-before-decision
    type: command
    match: "(default|choose).*(format|config|rule)"
    action: warn
    level: sprint
    priority: 0
    category: discipline
    severity: low
    confidence: low
    mode: warn
    rationale: "A model choosing a format/convention without checking the project's own is a common context-rot failure mode this repo's own standing requirements target directly."
    remediation: "Ask what the project already uses before deciding."
    false_positives:
      - "npm init -y or a config command that legitimately needs no user check — exempted via the unless clause."
    unless:
      - regex: "git config|npm config|pnpm config|yarn config|bun config|npx( |$)|npm exec|pipx|dlx( |$)|init( |$)|-y( |$)|--yes"
    message: "You are choosing a format without verifying the user. Ask what they use before deciding."

  # ── TIER 3: observe (evaluated + recorded via observed_action, never interrupts) ──
  - id: source-change-requires-test
    type: verification
    mode: observe
    category: discipline
    severity: medium
    confidence: medium
    trigger:
      tools: [write, edit, apply_patch, WriteFile]
      path: "src/"
      paths: ["package.json"]
      pattern: "(src/|package[.]json)"
    satisfy:
      tools: [Bash]
      pattern: "(npm test|npm run test|vitest|jest)"
    boundaries:
      commit:
        pattern: "git commit"
        action: warn
      push:
        pattern: "git push"
        action: deny
    verification_window_seconds: 300
    action: deny
    rationale: "RE-TIERED to mode: observe (was deny-on-push): this repo's own standing requirements already state the verification-culture expectation in prose; moving the hard enforcement to observe lets it burn in and measure its real hit/false-positive rate (via observed_action) before it interrupts commits/pushes again."
    remediation: "Run the project's test command after a source change, before committing or pushing."
    false_positives:
      - "A pure documentation or config change under src/ (e.g. a comment-only edit) that doesn't need a test run — now only logged, not blocked, while in observe."
    message: "Source changes require a successful test run before commit or push."

  - id: no-repeat-loops
    type: stuck
    match: "(npm|pnpm|yarn|bun)( run)? (test|build)|vitest|jest|pytest|go test|tsc|keel allow|git (commit|push)"
    mode: observe
    category: workflow
    severity: medium
    confidence: high
    priority: -10
    window_seconds: 900
    max_attempts: 3
    fingerprint: auto
    require_failure: true
    reset_on_success: true
    escalation:
      - at: 3
        action: redirect
        message: "This exact command has failed 3 times in 15 minutes. Stop retrying it. Research the exact error, state a root-cause hypothesis, then change approach."
      - at: 5
        action: deny
        message: "5 identical failures. Retrying without new information is blocked — record a hypothesis or ask the user."
    action: warn
    rationale: "Identical retries against the same failure are the single clearest signal of a stuck agent, and the one thing a rule engine can see that the model cannot: it runs outside the context window, where circling actually lives. Now shipped as a DEFAULT rather than an opt-in paste (previously 'keel rules harness --append') — on this project's own traces that inertia cost 41 distinct repeat loops across 20 sessions."
    remediation: "Search the exact error, state a hypothesis, or ask the user."
    false_positives:
      - "Polling a long-running job by re-running the same status command"
    message: "Identical failing command repeated — research the error and change approach."

  - id: research-before-fix
    type: research
    mode: observe
    category: workflow
    severity: medium
    confidence: medium
    priority: -10
    trigger:
      tools: [Bash]
      pattern: "(npm|pnpm|yarn|bun)( run)? (test|build)|vitest|jest|pytest|go test|tsc"
      exit: nonzero
    satisfy:
      tools: [Bash, WebSearch, WebFetch, websearch, webfetch, mcp__keel__keel_research]
      pattern: "(npm view|npm info|pip index|WebSearch|WebFetch|keel_research|keel_fetch)"
    boundaries:
      edit:
        pattern: "write|edit|apply_patch"
        action: redirect
    research_window_seconds: 600
    freshness_seconds: 1800
    action: redirect
    rationale: "Armed only by a FAILING command, never by green-field work — so it cannot slow down ordinary editing. It fires when a fix is about to be attempted against stale knowledge. NOTE (evaluated for this wave): this is a 'research'-type rule with a 'trigger', so the engine checks it in the pre-cache stateful loop, ahead of Tier 1/2 command rules in the same call — even in mode: observe this can short-circuit a Tier-1 rule's evaluation for the SAME write/edit call if a research obligation happens to be pending. Documented, not fixed here: fixing it is a pipeline.ts change, out of this lane's scope (see session/EVIDENCE/wave2-rules.md)."
    remediation: "Look up the failing module or error before patching it."
    message: "A command just failed and you are about to patch it without checking current docs. Research the error first."

  - id: root-cause-before-refactor
    type: diagnosis
    mode: observe
    category: workflow
    severity: medium
    confidence: medium
    priority: -10
    match: "(rm -rf|git checkout -- |git reset --hard|migrate|refactor)"
    require_hypothesis: true
    fallback_pattern: "git (log|blame|bisect|diff)"
    action: redirect
    rationale: "Complex or destructive fixes should follow an investigation, not precede one. Discharged by a recorded hypothesis OR by real investigation evidence (git log/blame/bisect/diff), so it never demands ceremony from someone who already did the work."
    remediation: "Run git log/blame/bisect, or record a hypothesis with keel_hypothesis."
    message: "Destructive or structural change without a recorded root cause. Investigate first."
`

/**
 * `keel install --mcp` — print ready-to-paste MCP config snippets. keel
 * speaks MCP (stdio or streamable-http) so ANY MCP-native agent platform
 * gets the keel_check / keel_audit / keel_requirements tools.
 */
function printMcpConfigs(): void {
  console.log(chalk.bold.cyan('\n  ⚓ keel as an MCP server'))
  console.log()
  console.log(chalk.dim('  keel serves keel_check (policy verdict), keel_audit (trace), and'))
  console.log(chalk.dim('  keel_requirements (standing requirements). Pick one transport:'))
  console.log()
  console.log(chalk.white('  STDIO (any platform that launches an MCP server):'))
  console.log(`    ${chalk.dim('command:')} keel`)
  console.log(`    ${chalk.dim('args:')} ["serve"]`)
  console.log()
  console.log(chalk.white('  STREAMABLE-HTTP (platforms with url-based MCP config):'))
  console.log(`    ${chalk.dim('url:')} http://127.0.0.1:3100`)
  console.log(`    ${chalk.dim('transport:')} streamable-http`)
  console.log(`    ${chalk.dim('headers:')} { "Authorization": "Bearer $KEEL_DAEMON_TOKEN" }`)
  console.log()
  console.log(chalk.white('  OpenClaw:'))
  console.log('    openclaw mcp set keel --command keel --args "[\'serve\']"')
  console.log()
  console.log(chalk.white('  Hermes (~/.hermes/config.yaml):'))
  console.log('    mcp_servers:')
  console.log('      keel:')
  console.log("        command: keel")
  console.log("        args: ['serve']")
  console.log()
  console.log(chalk.white('  Cline (.cline/cline_mcp_settings.json):'))
  console.log('    { "mcpServers": { "keel": { "command": "keel", "args": ["serve"] } } }')
  console.log()
  console.log(chalk.white('  OpenCode (opencode.json):'))
  console.log('    { "mcp": { "keel": { "type": "local", "command": ["keel", "serve"] } } }')
  console.log()
  console.log(chalk.white('  Claude Code (.mcp.json):'))
  console.log('    { "mcpServers": { "keel": { "command": "keel", "args": ["serve"] } } }')
  console.log()
  console.log(chalk.dim('  The tools are advisory for the agent (self-checks + audit); for hard'))
  console.log(chalk.dim('  enforcement use the pre-tool hook integration (keel install --opencode,'))
  console.log(chalk.dim('  --claude-code) or the gateway (keel gateway --command "<tool server>").'))
  console.log()
}

export async function installCommand(options: {
  opencode?: boolean
  project?: boolean
  claudeCode?: boolean
  cline?: boolean
  cursor?: boolean
  codex?: boolean
  hermes?: boolean
  openclaw?: boolean
  gemini?: boolean
  mcp?: boolean
  all?: boolean
}) {
  const keelDir = join(homedir(), '.keel')
  const rulesPath = join(keelDir, 'rules.yaml')

  // Rules are the base layer: EVERY install mode ensures ~/.keel/rules.yaml
  // exists (keel install --opencode must not leave "Next steps: review
  // rules.yaml" pointing at a file it never created). Idempotent when present.
  mkdirSync(keelDir, { recursive: true })
  if (!existsSync(rulesPath)) {
    writeFileSync(rulesPath, DEFAULT_RULES_YAML, 'utf-8')
    console.log(chalk.green('  ✓ Created ~/.keel/rules.yaml'))
  } else {
    console.log(chalk.dim('  ~/.keel/rules.yaml already exists (skipping)'))
  }

  // Create audit traces dir
  const tracesDir = join(keelDir, 'traces')
  mkdirSync(tracesDir, { recursive: true })
  console.log(chalk.dim('  ✓ Ensured ~/.keel/traces/ exists'))

  if (options.mcp) {
    printMcpConfigs()
    return
  }

  if (options.opencode || options.all) {
    await installOpenCodePlugin()
  }

  if (options.project || options.all) {
    await installProjectPlugin()
  }

  if (options.claudeCode || options.all) {
    await installClaudeCode()
  }

  if (options.cline || options.all) {
    await installCline()
  }

  if (options.cursor || options.all) {
    await installCursor()
  }

  if (options.codex || options.all) {
    await installCodex()
  }

  if (options.hermes || options.all) {
    await installHermes()
  }

  if (options.openclaw || options.all) {
    await installOpenClaw()
  }

  if (options.gemini || options.all) {
    await installGemini()
  }

  console.log(chalk.dim('\n  Next steps:'))
  console.log(chalk.dim('    1. Review ~/.keel/rules.yaml and customize'))
  if (options.opencode || options.all || options.project) {
    console.log(chalk.dim('    2. Restart OpenCode for the plugin to load'))
  } else if (options.claudeCode) {
    console.log(chalk.dim('    2. Restart Claude Code for the hooks to take effect'))
  } else {
    console.log(chalk.dim('    2. Run `keel install --opencode` to wire the OpenCode plugin'))
  }
  console.log(chalk.dim('    3. Run `keel validate` to check for conflicts'))

  // Print-only: never writes to rules.yaml (DEFAULT_RULES_YAML above is
  // untouched). If the install environment is already sandboxed at the OS
  // level, say so once, here, so it's visible before the user starts
  // hitting prompts they may not need. Silent when nothing is detected.
  const suggestion = sandboxSuggestion(detectSandbox())
  if (suggestion) {
    console.log()
    console.log(chalk.dim('    ') + chalk.yellow(suggestion))
  }

  console.log()
}

async function installOpenCodePlugin() {
  // Global install — auto-loaded from ~/.opencode/plugins/ in every project.
  const ocDir = join(homedir(), '.opencode', 'plugins')
  const pluginPath = join(ocDir, 'keel-enforce.js')

  mkdirSync(ocDir, { recursive: true })

  const source = await findPluginSource()
  if (source) {
    copyFileSync(source, pluginPath)
    console.log(chalk.green(`  ✓ Installed plugin to ${pluginPath}`))
  } else {
    console.log(chalk.red('  ✗ Plugin source not found. Run from the keel repo or reinstall the CLI.'))
    return
  }

  createRequirementsFile()
  upgradePluginConfig()
}

/**
 * Hermes Agent plugin — a thin client over the keel daemon.
 *
 * Hermes plugins are Python with a YAML manifest, so unlike the OpenCode
 * plugin there is nothing to bundle: two files into
 * ~/.hermes/plugins/keel/ and the daemon does the enforcing.
 */
async function installHermes() {
  const dir = join(homedir(), '.hermes', 'plugins', 'keel')
  mkdirSync(dir, { recursive: true })

  const plugin = await findTemplateSource(join('hermes', 'keel_plugin.py'))
  const manifest = await findTemplateSource(join('hermes', 'plugin.yaml'))
  if (!plugin || !manifest) {
    console.log(chalk.red('  ✗ Hermes plugin source not found. Run from the keel repo or reinstall the CLI.'))
    return
  }
  copyFileSync(plugin, join(dir, 'keel_plugin.py'))
  copyFileSync(manifest, join(dir, 'plugin.yaml'))
  // Hermes requires __init__.py exposing register(ctx).
  writeFileSync(join(dir, '__init__.py'), 'from .keel_plugin import register  # noqa: F401\n')
  console.log(chalk.green(`  ✓ Installed Hermes plugin to ${dir}`))

  createRequirementsFile()
  console.log()
  console.log(chalk.dim('  The Hermes plugin enforces through the keel daemon:'))
  console.log(chalk.dim('    • start it with `keel daemon` (it idles out after 10 min and respawns)'))
  console.log(chalk.dim('    • if the daemon is unreachable, only catastrophic commands are blocked'))
  console.log(chalk.dim('      and the plugin says so loudly — it never silently stops enforcing'))
  // Say what is NOT enforced, rather than letting it look covered.
  console.log(chalk.yellow('    • Hermes cannot rewrite tool arguments, so keel `fix` rules are'))
  console.log(chalk.yellow('      advisory there — they are reported, not applied'))
}

/**
 * OpenClaw plugin — a thin client over the keel daemon.
 *
 * Three files into ~/.openclaw/plugins/keel/. Nothing is bundled: the
 * plugin imports only node builtins, and `definePluginEntry` is
 * effectively identity, so the entry object is built as a literal.
 */
async function installOpenClaw() {
  const dir = join(homedir(), '.openclaw', 'plugins', 'keel')
  mkdirSync(dir, { recursive: true })

  const files = ['index.mjs', 'openclaw.plugin.json', 'package.json']
  for (const name of files) {
    const source = await findTemplateSource(join('openclaw', name))
    if (!source) {
      console.log(chalk.red(`  ✗ OpenClaw plugin source (${name}) not found. Run from the keel repo or reinstall the CLI.`))
      return
    }
    copyFileSync(source, join(dir, name))
  }
  console.log(chalk.green(`  ✓ Installed OpenClaw plugin to ${dir}`))

  createRequirementsFile()
  console.log()
  console.log(chalk.dim('  The OpenClaw plugin enforces through the keel daemon:'))
  console.log(chalk.dim('    • start it with `keel daemon` (it idles out after 10 min)'))
  console.log(chalk.dim('    • if the daemon is unreachable, only catastrophic commands are blocked'))
  console.log(chalk.dim('      and the plugin says so loudly — it never silently stops enforcing'))
  console.log(chalk.dim('    • approval gates fail CLOSED: an unanswered prompt denies, never allows'))
  console.log()
  console.log(chalk.yellow('  Enable it in your OpenClaw config, then restart:'))
  console.log(chalk.dim('    plugins.load.paths  += "~/.openclaw/plugins/keel"'))
  // OpenClaw's own doctor flags a plugin loaded without provenance as
  // untracked local code. Pinning it in plugins.allow is what clears that.
  console.log(chalk.dim('    plugins.allow       += "keel"      (pins trust; clears the provenance warning)'))
}

/**
 * Install a host's pre-tool hook.
 *
 * The prose files these installers used to write on their own are the
 * prompt layer; this is the enforcement layer. Without it,
 * `keel install --cursor|--codex|--cline` printed a green check while
 * enforcing nothing — a guardrail that is believed but absent is worse
 * than none.
 */
async function installHostHook(spec: { label: string; template: string; target: string; note?: string }) {
  const source = await findTemplateSource(spec.template)
  if (!source) {
    console.log(chalk.red(`  ✗ ${spec.label} hook source not found. Run from the keel repo or reinstall the CLI.`))
    return
  }
  mkdirSync(dirname(spec.target), { recursive: true })
  copyFileSync(source, spec.target)
  chmodSync(spec.target, 0o755)
  console.log(chalk.green(`  ✓ Installed ${spec.label} pre-tool hook → ${spec.target}`))
  if (spec.note) console.log(chalk.yellow(`    ${spec.note}`))
}

/**
 * Gemini CLI hook.
 *
 * Gemini ships `gemini hooks migrate --from-claude`, which exists to
 * convert Claude Code hooks into its own format — so the two are
 * equivalent by the vendor's own account, and keel reuses the Claude Code
 * contract rather than guessing a separate one.
 */
async function installGemini() {
  await installHostHook({
    label: 'Gemini CLI',
    template: 'gemini-pretooluse.sh',
    target: join(homedir(), '.gemini', 'hooks', 'PreToolUse'),
    note: 'Claude-Code-compatible by construction. If Gemini\'s format has drifted, run `gemini hooks migrate --from-claude`.',
  })
  console.log(chalk.dim('    Gemini also has its own Policy Engine (--policy/--admin-policy);'))
  console.log(chalk.dim('    this hook is independent of it and enforces your keel rules.'))
}

async function installProjectPlugin() {
  const cwd = process.cwd()

  // Project plugin — auto-loaded from <project>/.opencode/plugins/.
  const ocDir = join(cwd, '.opencode', 'plugins')
  const pluginPath = join(ocDir, 'keel-enforce.js')

  mkdirSync(ocDir, { recursive: true })

  const source = await findPluginSource()
  if (source) {
    copyFileSync(source, pluginPath)
    console.log(chalk.green(`  ✓ Installed plugin to ${pluginPath}`))
  } else {
    console.log(chalk.red('  ✗ Plugin source not found. Run from the keel repo or reinstall the CLI.'))
    return
  }

  // Project rules — loaded by the plugin alongside global rules.
  const keelDir = join(cwd, '.keel')
  mkdirSync(keelDir, { recursive: true })
  const rulesFile = join(keelDir, 'rules.yaml')
  if (!existsSync(rulesFile)) {
    // `rules:` followed only by comment lines (no list items) YAML-parses
    // to `rules: null`, which parseRulesContent rejects as "Rules must be
    // an array" — and initEnforce throws on that, breaking `keel evaluate`
    // and `keel hook <host>` on EVERY tool call from a fresh --project
    // install (only OpenCode's own fallback masked it). `rules: []` is
    // valid and parses to an empty, harmless rule set.
    writeFileSync(rulesFile, `# Project-specific Keel rules
# Enforced alongside global rules in ~/.keel/rules.yaml.
# Project rules override global rules for the same rule id.
# Add project-specific rules here — see ~/.keel/rules.yaml for examples.
version: 1
rules: []
`, 'utf-8')
    console.log(chalk.green(`  ✓ Created ${rulesFile}`))
  } else {
    console.log(chalk.dim(`  ${rulesFile} already exists (skipping)`))
  }

  // Project standing requirements — injected into every turn for this project.
  await createProjectRequirementsFile(keelDir)
}

function upgradePluginConfig() {
  const configDir = join(homedir(), '.config', 'opencode')
  const configPath = join(configDir, 'opencode.json')

  // Note: plugins in .opencode/plugins/ are auto-loaded.
  // The config entry is optional but recommended for documentation.
  // For npm package users, they should use "@get-keel/opencode-plugin" in the config.

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      const plugins = config.plugin || []

      // Remove old keel entries (v1 subprocess-based)
      const filtered = plugins.filter((p: string) =>
        !p.includes('keel-enforce')
      )

      config.plugin = filtered
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
      console.log(chalk.dim('  Plugin auto-loaded from .opencode/plugins/'))
      console.log(chalk.dim('  For npm: add "@get-keel/opencode-plugin" to opencode.json'))
    } catch {
      // Ignore parse errors
    }
  }
}

function createRequirementsFile() {
  const reqPath = join(homedir(), '.keel', 'requirements.md')
  if (existsSync(reqPath)) {
    console.log(chalk.dim('  .keel/requirements.md already exists (skipping)'))
    return
  }
  mkdirSync(join(homedir(), '.keel'), { recursive: true })
  writeDraftRequirements(reqPath)
}

async function createProjectRequirementsFile(keelDir: string) {
  const reqPath = join(keelDir, 'requirements.md')
  if (existsSync(reqPath)) {
    console.log(chalk.dim(`  ${reqPath} already exists (skipping)`))
    return
  }
  mkdirSync(keelDir, { recursive: true })
  writeDraftRequirements(reqPath)
}

async function writeDraftRequirements(reqPath: string) {
  // Prefer the canonical draft template; fall back to an inline copy.
  const source = await findRequirementsSource()
  const draft = source
    ? readFileSync(source, 'utf-8')
    : `# Standing Requirements

Keel injects this file into your agent's system prompt on every turn, so these
survive long sessions, compaction, and context rot. Edit it freely — it is yours.

## Verification culture
- Before ANY claim of completion ("done", "fixed", "ready", "working", "tested", "verified"):
  1. Run the project's real test command — not just a build or a type-check
  2. Include the output in the response as evidence
  3. List what changed, and how each change was verified
- A compile check is NOT verification. A passing build is not a passing test.
- "I believe it works" is not evidence. Show the output.

## Root cause before fix
- Diagnose the cause before changing code. A fix aimed at a symptom usually moves the bug.
- Before proposing a plan, state what it does NOT address.
- Distinguish a patch (suppresses the symptom) from a fix (removes the cause).

## When stuck
- After two failed attempts at the same approach, stop. Do not retry a third time.
- Escalate: search the exact error, re-read the source that failed, or ask.
- Say plainly when you are stuck. Circling silently is worse than asking.

## Decision-making
- When choosing a format, convention, or tool: ask what this project already uses. Never default.
- Verify a convention is actually enforced before relying on it.
- Be explicit about what you have tested versus what you are assuming.

## Context awareness
- In long sessions, re-read these requirements — they were stated early and degrade as context fills.
- If a requirement conflicts with something read recently, the standing requirement wins.

## Self-enforcement
- Incorporate these requirements into your behaviour as soon as you read them.
- Treat them as if stated by the user at the start of the conversation.
`
  writeFileSync(reqPath, draft, 'utf-8')
  console.log(chalk.green(`  ✓ Created ${reqPath}`))
}

async function installClaudeCode() {
  const cwd = process.cwd()
  const hooksDir = join(cwd, '.claude', 'hooks')

  // PreToolUse — blocks rule violations before tool execution.
  const preToolUsePath = join(hooksDir, 'PreToolUse', 'keel-enforce')
  const preSource = await findTemplateSource('claude-pretooluse.sh')
  if (preSource) {
    mkdirSync(join(hooksDir, 'PreToolUse'), { recursive: true })
    copyFileSync(preSource, preToolUsePath)
    chmodSync(preToolUsePath, 0o755)
    console.log(chalk.green(`  ✓ Installed PreToolUse hook → ${preToolUsePath}`))
  }

  // PostToolUse — re-injects standing requirements after every tool call.
  const postToolUsePath = join(hooksDir, 'PostToolUse', 'keel-reinject')
  const postSource = await findTemplateSource('claude-posttooluse.sh')
  if (postSource) {
    mkdirSync(join(hooksDir, 'PostToolUse'), { recursive: true })
    copyFileSync(postSource, postToolUsePath)
    chmodSync(postToolUsePath, 0o755)
    console.log(chalk.green(`  ✓ Installed PostToolUse hook → ${postToolUsePath}`))
  }

  // Register hooks in .claude/settings.json (project-level).
  const settingsPath = join(cwd, '.claude', 'settings.json')
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      console.log(chalk.yellow(`  ⚠ ${settingsPath} has invalid JSON — creating a backup and starting fresh.`))
      copyFileSync(settingsPath, settingsPath + '.bak')
      settings = {}
    }
  }

  const hooks = (settings.hooks as Record<string, unknown>) || {}
  hooks.PreToolUse = [
    {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: `.claude/hooks/PreToolUse/keel-enforce`,
        },
      ],
    },
  ]
  hooks.PostToolUse = [
    {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: `.claude/hooks/PostToolUse/keel-reinject`,
        },
      ],
    },
  ]
  settings.hooks = hooks

  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
  console.log(chalk.green(`  ✓ Registered hooks in ${settingsPath}`))
}

// ── Cline (advisory: .clinerules + MCP check server) ──
async function installCline() {
  const cwd = process.cwd()

  // .clinerules — read by Cline at session start (advisory layer).
  const clineRulesPath = join(cwd, '.clinerules')
  const rulesContent = `# Keel standing requirements

This project enforces standing requirements via Keel. Follow them at all times:

- Before claiming completion, run the project's tests and include the output as evidence.
- Build success does not mean tests pass. Run tests, not just a build.
- When choosing a format, config, or convention, ask the user what they use. Never default.
- Re-check the user's standing requirements in long sessions — early instructions degrade from context.
- If a requirement conflicts with recently accessed information, the standing requirement wins.

Full requirements: ~/.keel/requirements.md
Project requirements: .keel/requirements.md (if present)
`
  if (!existsSync(clineRulesPath)) {
    writeFileSync(clineRulesPath, rulesContent, 'utf-8')
    console.log(chalk.green(`  ✓ Created ${clineRulesPath}`))
  } else if (!readFileSync(clineRulesPath, 'utf-8').includes('Keel standing requirements')) {
    appendClineRules(clineRulesPath, rulesContent)
    console.log(chalk.green(`  ✓ Appended Keel requirements to ${clineRulesPath}`))
  } else {
    console.log(chalk.dim(`  ${clineRulesPath} already has Keel requirements (skipping)`))
  }

  await installHostHook({
    label: 'Cline',
    template: 'cline-pretooluse.sh',
    target: join(homedir(), '.cline', 'hooks', 'PreToolUse'),
  })

  // MCP server — gives Cline an enforcement check tool.
  const clineDir = join(cwd, '.cline')
  const settingsPath = join(clineDir, 'cline_mcp_settings.json')
  let settings: { mcpServers?: Record<string, unknown> } = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      console.log(chalk.yellow(`  ⚠ ${settingsPath} has invalid JSON — creating a backup and starting fresh.`))
      copyFileSync(settingsPath, settingsPath + '.bak')
      settings = {}
    }
  }
  settings.mcpServers = settings.mcpServers || {}
  settings.mcpServers.keel = {
    command: 'keel',
    args: ['serve'],
    env: {},
  }
  mkdirSync(clineDir, { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
  console.log(chalk.green(`  ✓ Registered keel MCP server in ${settingsPath}`))
}

function appendClineRules(path: string, content: string) {
  const existing = readFileSync(path, 'utf-8').trimEnd()
  writeFileSync(path, existing + '\n\n' + content, 'utf-8')
}

// ── Cursor (advisory: .cursor/rules declarative rules) ──
async function installCursor() {
  const cwd = process.cwd()
  const rulesDir = join(cwd, '.cursor', 'rules')
  const rulePath = join(rulesDir, 'keel.mdc')

  const mdc = `---
description: Keel enforcement — standing requirements and rule reminders
globs: **/*
alwaysApply: true
---

# Keel enforcement

This project uses Keel to enforce rules OUTSIDE the agent's context window.
Follow these standing requirements at all times:

- Before claiming completion ("done", "fixed", "verified"), run the project's tests and include the output as evidence.
- Build success does not mean tests pass. Run tests, not just a build.
- When choosing a format, config, or convention, ask the user what they use. Never default.
- Re-check the user's standing requirements in long sessions — early instructions degrade from context.
- If a requirement conflicts with recently accessed information, the standing requirement wins.

Keel rules are enforced at tool-call time by the OpenCode plugin or Claude Code hooks.
Full rules: ~/.keel/rules.yaml
Full requirements: ~/.keel/requirements.md
`

  mkdirSync(rulesDir, { recursive: true })
  writeFileSync(rulePath, mdc, 'utf-8')

  await installHostHook({
    label: 'Cursor',
    template: 'cursor-beforeshellexecution.sh',
    target: join(cwd, '.cursor', 'hooks', 'keel-enforce.sh'),
    note: 'UNVERIFIED against a live Cursor — contract taken from docs, not installed types.',
  })
  // failClosed: a crash in the hook must deny, not silently allow.
  const cursorHooks = join(cwd, '.cursor', 'hooks.json')
  if (!existsSync(cursorHooks)) {
    writeFileSync(cursorHooks, JSON.stringify({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: './.cursor/hooks/keel-enforce.sh', failClosed: true }],
        beforeMCPExecution: [{ command: './.cursor/hooks/keel-enforce.sh', failClosed: true }],
      },
    }, null, 2) + '\n', 'utf-8')
    console.log(chalk.green(`  ✓ Wired ${cursorHooks} (failClosed: true)`))
  } else {
    console.log(chalk.yellow(`  ! ${cursorHooks} exists — add the keel hook to beforeShellExecution yourself`))
  }
  console.log(chalk.green(`  ✓ Created ${rulePath}`))
  console.log(chalk.dim('  Note: Cursor has no blocking hooks — these are advisory rules.'))
}

// ── Codex CLI (advisory: AGENTS.md section) ──
async function installCodex() {
  await installHostHook({
    label: 'Codex CLI',
    template: 'codex-pretooluse.sh',
    target: join(homedir(), '.codex', 'hooks', 'keel-enforce.sh'),
    note: 'UNVERIFIED against a live Codex CLI — register it in ~/.codex/hooks.json as a PreToolUse hook. Codex requires the hook file hash to be trusted before it runs.',
  })

  const cwd = process.cwd()
  const agentsPath = join(cwd, 'AGENTS.md')

  const section = `
## Keel standing requirements

This project enforces standing requirements via Keel. Follow them at all times:

- Before claiming completion, run the project's tests and include the output as evidence.
- Build success does not mean tests pass. Run tests, not just a build.
- When choosing a format, config, or convention, ask the user what they use. Never default.
- Re-check the user's standing requirements in long sessions — early instructions degrade from context.
- If a requirement conflicts with recently accessed information, the standing requirement wins.

Full requirements: ~/.keel/requirements.md
`

  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, section.trimStart(), 'utf-8')
    console.log(chalk.green(`  ✓ Created ${agentsPath} with Keel requirements`))
  } else if (!readFileSync(agentsPath, 'utf-8').includes('Keel standing requirements')) {
    const existing = readFileSync(agentsPath, 'utf-8').trimEnd()
    writeFileSync(agentsPath, existing + '\n' + section, 'utf-8')
    console.log(chalk.green(`  ✓ Appended Keel requirements to ${agentsPath}`))
  } else {
    console.log(chalk.dim(`  ${agentsPath} already has Keel requirements (skipping)`))
  }
  console.log(chalk.dim('  Note: Codex CLI has no blocking hooks — these are advisory instructions.'))
}
