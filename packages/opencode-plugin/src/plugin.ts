import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  ActionCache,
  ContentTracker,
  EnforcementPipeline,
  FlowTracker,
  SequenceDetector,
  StateManager,
  StuckTracker,
  OscillationTracker,
  SessionTracker,
  BudgetTracker,
  PersistentBudgetStore,
  measureOpenCodeSpend,
  ResearchTracker,
  loadRuleHierarchy,
  parseRulesContent,
  hashRulesFile,
  validateRules,
  projectAuditArgs,
  createReceipt,
  verifyFileSyntax,
  isVerifiableFile,
  resolveHome,
} from '../../core/src/keel-core.js'

/** Tools whose completion means a file on disk just changed. */
const EDIT_TOOLS = new Set(['write', 'edit', 'apply_patch', 'writefile', 'write_file', 'multiedit'])

// resolveHome() (KEEL_HOME > HOME > homedir()) so this plugin agrees with
// `keel install` and every other reader under KEEL_HOME. Computed once at
// plugin-module-load time, same as before (this file has always frozen its
// .keel-relative constants at import time — scripts/load-test.js already
// documents that HOME/KEEL_HOME must be set BEFORE the plugin module is
// imported for exactly this reason).
const HOME_DIR = resolveHome()
const KEEL_DIR = path.join(HOME_DIR, '.keel')
const RULES_PATH = path.join(KEEL_DIR, 'rules.yaml')
const REQUIREMENTS_PATH = path.join(KEEL_DIR, 'requirements.md')

// OpenCode's OWN data directory — deliberately NOT resolveHome()-derived:
// `~/.local/share/opencode/opencode.db` is OpenCode's own footprint, not
// keel's, so a KEEL_HOME redirect (which relocates keel's OWN state) has
// no reason to relocate it. `os.homedir()` mirrors what OpenCode itself
// resolves for its default XDG-ish data dir. `KEEL_OPENCODE_DB_PATH`
// overrides it for tests and non-standard installs, same override-env-var
// shape as `KEEL_STATE_DIR`/`KEEL_TRACES_DIR` elsewhere in this codebase.
// See core/src/enforce/budget/opencode-db.ts for why this is a COMPLETELY
// SEPARATE read path from the Claude Code transcript one (OpenCode already
// computes `cost` in dollars itself; no pricing table needed here).
const OPENCODE_DB_PATH = process.env.KEEL_OPENCODE_DB_PATH
  || path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
const DISABLED_PATH = path.join(KEEL_DIR, 'DISABLED')
let sentinelCorrupted = false
// `keel halt`'s sentinel — the inverse of DISABLED_PATH above. DISABLED
// ALLOWS every call while present; HALTED DENIES every call while present.
// Checked FIRST in the `before` gate below (ahead of isDisabled()) so a
// halt wins even when both sentinels exist — see isHalted()'s own comment.
const HALTED_PATH = path.join(KEEL_DIR, 'HALTED')
// KEEL_TRACES_DIR mirrors state-manager.ts:21's KEEL_STATE_DIR — same
// env-override-else-real-home shape — so this plugin's own traces never
// have to land in ~/.keel/traces during a load-test or a future in-process
// harness run.
const TRACES_DIR = process.env.KEEL_TRACES_DIR || path.join(KEEL_DIR, 'traces')
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
    match: "keel[ \t]+(disable|allow|level|enforce|install|uninstall|promote|halt|resume)([ \t]|$)|keel[ \t]+rules[ \t][^|;&]*--append"
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
      - "**/.keel/HALTED"
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
    match: "rm[^|;&]*[.]opencode/plugins/|rm[^|;&]*[.]keel/(rules[.]yaml|plugins|DISABLED|HALTED)|rm[^|;&]*[ \t/][.]keel([ \t]|/?$)"
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


  # ── self-protection write gate (Tier 1; supervisor paste at gate-3, secreview) ──
  - id: no-self-protection-write
    type: command
    match: "(>>?|(?<![A-Za-z])(tee( +-a)?|cp|mv|install|ln|truncate|dd|rsync)(?![A-Za-z])|(?<![A-Za-z])sed +-i[^|;&]*|(?<![A-Za-z])python3? +-c[^|;&]*|(?<![A-Za-z])node +-e[^|;&]*|(?<![A-Za-z])perl +-[ep][^|;&]*)[^|;&]*[^A-Za-z0-9_-]([.]keel/(rules[.]yaml|plugins)|[.]keel[.]local[.]yaml|[.]claude/settings([.]local)?[.]json|[.]mcp[.]json|[.]vscode/settings[.]json|[.]git/hooks/|[.]opencode/plugins/|[.]keel/DISABLED|[.]keel/HALTED)|git +config[^|;&]*core[.]hooksPath"
    action: deny
    level: protect
    priority: 95
    category: bypass
    severity: critical
    confidence: high
    mode: block
    rationale: "no-rules-tampering is a filesystem rule and therefore only sees a tool call's path ARGUMENT; a shell redirect's target is invisible to it. Measured in session/EVIDENCE/wave3-secreview.md: 21 of 21 shell writes to the self-protection path list were allowed, including a one-command write of the kill-switch sentinel that disables every rule at every dial. Same CVE-2025-59536/CVE-2026-21852 class as the filesystem rule it companions."
    remediation: "Edit .claude/settings.json, .mcp.json, .vscode/settings.json, git hooks, or keel's own files yourself, in your own terminal."
    false_positives:
      - "An ordinary editor-preference write to .vscode/settings.json through the shell is blocked -- the same accepted trade-off no-rules-tampering already documents for that path."
      - "Scaffolding a brand-new project's .mcp.json with a heredoc or redirect is blocked; ask the user to run it."
      - "A file literally named .mcp.json anywhere outside the project root is still matched -- the path fragments are matched anywhere in the command, not anchored to the project."
      - "A commit message that merely quotes one of these paths is NOT matched (verified: git commit -m with .mcp.json in the message passes), because a write verb must also be present."
      - "A diagnostic READ of the sentinel or any of these config files (cat, ls, grep of .keel/DISABLED, .keel/HALTED, .mcp.json, .claude/settings.json) is NOT blocked -- every path alternative here requires a preceding write verb or redirect, so reads pass and only writes are denied (verified live, v0.4 red-team)."
    message: "Writing to keel's own files, the agent's trust/approval config, or git hooks through a shell command is blocked -- these are user-owned."
  - id: agent-env-hijack
    type: command
    match: "(?<![A-Za-z])export +(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*) *=.*(>>|>) *[^ ]*([.]bashrc|[.]zshrc|[.]zshenv|[.]zprofile|[.]zlogin|[.]bash_profile|[.]profile|[.]env)(?![A-Za-z])|(?<![A-Za-z])(echo|printf)(?![A-Za-z])[^|;&]*(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*) *=.*(>>|>) *[^ ]*([.]bashrc|[.]zshrc|[.]zshenv|[.]zprofile|[.]zlogin|[.]bash_profile|[.]profile|[.]env|[.]mcp[.]json)(?![A-Za-z])|(?<![A-Za-z])sed +-i[^|;&]*(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*)(?![A-Za-z])|(?<![A-Za-z])tee +-a? *[^ ]*([.]bashrc|[.]zshrc|[.]zshenv|[.]zprofile|[.]zlogin|[.]bash_profile|[.]profile)(?![A-Za-z])[^|;&]*(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*)(?![A-Za-z])|(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*)[^;&]*[|][ \t]*(sudo[ \t]+)?tee[ \t]+(-a[ \t]*)?[^ ]*([.]bashrc|[.]zshrc|[.]zshenv|[.]zprofile|[.]zlogin|[.]bash_profile|[.]profile)(?![A-Za-z])"
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
    match: '(?<!["''])rm[ \t]+-(rf|fr|r[ \t]+-f|-recursive[ \t]+--force|-force[ \t]+--recursive)[ \t]+/(?!tmp|var/tmp)|(?<!["''])rm[ \t]+-(rf|fr|r[ \t]+-f|-recursive[ \t]+--force|-force[ \t]+--recursive)[ \t]+(~|[$][{]?HOME[}]?/?([ \t]|$))|(?<!["''])rm[ \t]+-(rf|fr|r[ \t]+-f|-recursive[ \t]+--force|-force[ \t]+--recursive)[ \t]+[.]([ \t]|$)|(?<!["''])rm[ \t]+-(rf|fr|r[ \t]+-f|-recursive[ \t]+--force|-force[ \t]+--recursive)[ \t]+[.][.]([ \t]|/|$)|(?<!["''])rm[ \t]+-(rf|fr|r[ \t]+-f|-recursive[ \t]+--force|-force[ \t]+--recursive)[ \t]+[.][/](([*])?([ \t]|$))|(?<!["''])rm[ \t]+-(rf|fr|r[ \t]+-f|-recursive[ \t]+--force|-force[ \t]+--recursive)[ \t]+[*]([ \t]|$)|(?<!["''])rm[ \t]+-(rf|fr|r[ \t]+-f|-recursive[ \t]+--force|-force[ \t]+--recursive)[ \t]+/tmp/[^ ]*[.][.]([/ \t]|$)|chmod[ \t]+-R[ \t]+(777|000|a[+=]rwx)[ \t]+([/~][^ ]*|[.])([ \t]|$)|mkfs[.0-9a-zA-Z_]*([ \t]|$)|mke2fs([ \t]|$)|newfs_[a-z0-9]+([ \t]|$)|diskutil[ \t]+(eraseDisk|eraseVolume|zeroDisk|reformat|partitionDisk)(?![A-Za-z])|(?<!["''])rm[^|;&]*--no-preserve-root|shred([ \t]|$)|wipefs([ \t]|$)|blkdiscard([ \t]|$)|dd[ \t][^|;&]*of=/dev/(?!null([ \t]|$)|zero([ \t]|$)|stdout|stderr|tty)[^ ]+|>[ \t]*/dev/(disk[0-9]+|rdisk[0-9]+|sd[a-z]+[0-9]*|hd[a-z]+[0-9]*|vd[a-z]+[0-9]*|nvme[0-9]+n[0-9]+|xvd[a-z]+[0-9]*|mmcblk[0-9]+)([ \t]|$)|[; ][:][ \t]*[()][ \t]*[()][ \t]*[{][ \t]*[:][ \t]*[|]:&|^[:][ \t]*[()][ \t]*[()][ \t]*[{][ \t]*[:][ \t]*[|]:&'
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

  - id: no-destructive-interpreter-body
    type: command
    match: 'shutil[.]rmtree[(][ ]*[''"]?/[''"]?[ ]*[,)]|shutil[.]rmtree[(][ ]*[''"]?~/?[''"]?[ ]*[,)]|os[.]system[(][ ]*[''"][^''"]*rm[ ]+-[a-zA-Z-]*r[a-zA-Z-]*f[a-zA-Z-]*[ ]+(/|~)|subprocess[.](run|call|Popen|check_call|check_output)[(][ ]*[''"][^''"]*rm[ ]+-[a-zA-Z-]*r[a-zA-Z-]*f[a-zA-Z-]*[ ]+(/|~)|subprocess[.](run|call|Popen|check_call|check_output)[(][^)]*[''"]rm[''"][^)]*[''"]-[a-zA-Z-]*r[a-zA-Z-]*f[a-zA-Z-]*[''"][^)]*[''"](/|~)[''"]|(rmSync|rmdirSync)[(][ ]*[''"]?/[''"]?[ ]*[,)]|(rmSync|rmdirSync)[(][ ]*[''"]?~/?[''"]?[ ]*[,)]|os[.]remove[(][ ]*[''"]?/[''"]?[ ]*[,)]'
    action: deny
    level: protect
    priority: 88
    category: destructive
    severity: critical
    confidence: high
    mode: block
    rationale: "M1 follow-up to the A2 shell-parse layer: command-normalizer.ts now exposes an interpreter one-liner's decoded body (python -c, node -e, perl -e) as its own matching surface, but until this rule shipped no default pattern targeted destructive calls written IN that body instead of as a shell verb — python3 -c with shutil.rmtree('/') denied nothing. Scoped to a literal root or home target only (shutil.rmtree, os.system/subprocess running rm -rf against / or ~, os.remove('/'), fs.rmSync/rmdirSync against / or ~), mirroring no-destructive-commands' own root/home scoping so ordinary cleanup code (shutil.rmtree of a build dir, os.remove of a temp file) is untouched."
    remediation: "Call the interpreter body against a specific named path inside the project instead of the filesystem root or home directory."
    false_positives:
      - "shutil.rmtree('./build'), shutil.rmtree(tmp_dir), os.remove('/tmp/tempfile.txt'), fs.rmSync('./dist') — all allowed: the target is not the literal root or home path."
      - "subprocess.run(['terraform','apply','-refresh=true','-target=/infra']) is allowed — the rm/-rf/root-path pieces are not all present as their own quoted tokens or within one string argument."
    message: "Destructive filesystem calls inside an interpreter one-liner body (python -c, node -e, sh -c) targeting root or home are blocked."

  - id: no-force-push
    type: command
    match: "git ((--no-pager )|(-C [^ ]+ ))*push.*--force(?!-with-lease)( |=|$)|git ((--no-pager )|(-C [^ ]+ ))*push.*(^| )-f( |=|$)|git[ \t]+((--no-pager|-C[ \t]+[^ ]+|-c[ \t]+[^ ]+)[ \t]+)*push[^|;&]*[ \t][+](main|master)(?![A-Za-z])"
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
    match: "git[ \t]+((--no-pager|-C[ \t]+[^ ]+|-c[ \t]+[^ ]+)[ \t]+)*reset[ \t]+--hard[ \t]+(origin/)?(main|master)(?![A-Za-z])|git[ \t]+((--no-pager|-C[ \t]+[^ ]+|-c[ \t]+[^ ]+)[ \t]+)*checkout[ \t]+(origin/)?(main|master)(?![A-Za-z])[^|;&]*(&&|;)[ \t]*git[ \t]+((--no-pager|-C[ \t]+[^ ]+|-c[ \t]+[^ ]+)[ \t]+)*reset[ \t]+--hard|git[ \t]+((--no-pager|-C[ \t]+[^ ]+|-c[ \t]+[^ ]+)[ \t]+)*switch[ \t]+(origin/)?(main|master)(?![A-Za-z])[^|;&]*(&&|;)[ \t]*git[ \t]+((--no-pager|-C[ \t]+[^ ]+|-c[ \t]+[^ ]+)[ \t]+)*reset[ \t]+--hard"
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
    match: "git[ \t]+((--no-pager|-C[ \t]+[^ ]+|-c[ \t]+[^ ]+)[ \t]+)*push[^|;&]*(--delete|-d)[ \t]+(origin[ \t]+)?(refs/heads/)?(main|master)(?![A-Za-z])|git[ \t]+((--no-pager|-C[ \t]+[^ ]+|-c[ \t]+[^ ]+)[ \t]+)*push[^|;&]*[ \t]:(refs/heads/)?(main|master)(?![A-Za-z])|git[ \t]+((--no-pager|-C[ \t]+[^ ]+|-c[ \t]+[^ ]+)[ \t]+)*branch[ \t]+(-D|--delete)[ \t]+(main|master)(?![A-Za-z])|git[ \t]+((--no-pager|-C[ \t]+[^ ]+|-c[ \t]+[^ ]+)[ \t]+)*update-ref[ \t]+-d[ \t]+refs/heads/(main|master)(?![A-Za-z])"
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
    match: "(?<![A-Za-z])(curl|wget|ncat|socat|nc)(?![A-Za-z])[^;&]*[|][ \t]*(sudo[ \t]+)*(ba|z|k|da|a)?sh([ \t]|$)|(ba|z|k|da|a)?sh <[(](?<![A-Za-z])(curl|wget|ncat|socat|nc)(?![A-Za-z])|(?<![A-Za-z])(ba|z|k|da|a)?sh(?![A-Za-z])[ \t]+-c[ \t]+.*[$][(][^)]*(?<![A-Za-z])(curl|wget|ncat|socat|nc)(?![A-Za-z])|(?<![A-Za-z])eval(?![A-Za-z])[ \t]+.*[$][(][^)]*(?<![A-Za-z])(curl|wget|ncat|socat|nc)(?![A-Za-z])"
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
      - "A deploy step that rsyncs or scps BUILD OUTPUT to a remote host, run in the same session as an earlier, unrelated read of a secret file (e.g. an env var lookup during setup), will still deny — the flow tracker has no payload correlation: it only knows a secret was read THIS session and a remote-copy sink ran, not whether the same bytes moved. rsync/scp joined the sink verb list in the M5 lane, closing a documented miss (SECURITY.md's no-exfil-flow redteam row); a single command that reads AND sends a secret in one shot (curl -d @.env host) remains a known, separate gap — the tracker needs two distinct tool calls to correlate. See docs/exfil.md."
    message: "Data read from sensitive files must not be sent over the network."

  - id: no-exfil-flow-cross-call
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
    action: warn
    level: sprint
    priority: 84
    category: exfil
    severity: high
    confidence: medium
    mode: warn
    cross_call: true
    rationale: "no-exfil-flow's in-memory FlowTracker only correlates a read and a later sink inside ONE live process (see docs/exfil.md). keel hook <host> (Claude Code, Gemini CLI, Cursor, Codex, cline, generic) runs a fresh process per tool call, so that correlation was inert there beyond a single piped command. This sibling rule checks the SAME sources/sinks against a persisted, session-scoped, TTL'd store (flow-store.ts, PersistentFlowStore) instead of in-memory state, so a read in one hook process and a sink in a LATER one, same session, now produces a signal too. Shipped as warn, not deny: the correlation window here is the store's TTL (about an hour), not one live process, so a legitimate build that reads a token in one call and hits the network in a later, unrelated one is a realistic hit, not an edge case a hard block could absorb."
    remediation: "If this fires on a routine build or deploy step, it is very likely a false positive from an unrelated earlier read this session — no-exfil-flow (deny) is the rule to treat as a real interruption; this one is an early-warning signal only."
    false_positives:
      - "The same false-positive shape no-exfil-flow already documents (an unrelated secret read earlier in the session, followed by an unrelated network call later) — but wider, because the correlation window here spans MULTIPLE processes over the store's TTL, not one live process. This is exactly why this rule is warn/sprint, not deny/protect."
    message: "Cross-call correlation: an earlier hook call this session read a credential-shaped path; this call looks network-shaped. If unrelated, this is a false positive - see no-exfil-flow for the hard-block version of this pattern."

  - id: prod-db-destruction
    type: command
    match: "(?=.*(?<![A-Za-z])(prod|production|live)(?![A-Za-z]))(?=.*(psql|mysql|sqlite3|mariadb|pg_restore|cockroach)(?![A-Za-z]))(?=.*(DROP[ \t\\n]+(TABLE|DATABASE|SCHEMA)|TRUNCATE(?![A-Za-z])|DELETE[ \t]+FROM))(psql|mysql|sqlite3|mariadb|pg_restore|cockroach|.)"
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
      - regex: "--context[= ](?:(docker-desktop|minikube|local|orbstack|rancher-desktop)(?![A-Za-z0-9-])|(kind-[a-z0-9-]+|k3d-[a-z0-9-]+)(?![A-Za-z]))"
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
    match: "(?<![A-Za-z])sudo(?![A-Za-z])(?![^;&|\\n]*(?<![A-Za-z])(apt-get|apt|yum|dnf|brew)(?![A-Za-z]))|(?<![A-Za-z])chmod +-R +[0-7]{3,4}(?![A-Za-z0-9])|(?<![A-Za-z])chown +-R(?![A-Za-z])"
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
    match: "(?<![A-Za-z0-9-])(npx|bunx|npm exec|pipx)( |$)|(?<![A-Za-z0-9-])(pnpm|yarn) dlx( |$)"
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
    # redact_span: true (sprint/lane-c2) marks a pattern whose match span
    # fully covers the secret bytes themselves, safe for
    # EnforcementPipeline.evaluateOutput() (output redaction, a DIFFERENT
    # consumer than the deny-on-write check below — this field has no
    # effect on that check) to replace in place. The last three patterns
    # here deliberately do NOT set it: they match only a LABEL or HEADER
    # (aws_secret_access_key=, a PEM BEGIN line) — the real secret sits
    # AFTER the match, uncovered by it. Redacting just the label would
    # strip the label and leave the actual key/PEM body sitting right next
    # to a "[redacted]" marker — a false-confidence signal worse than no
    # redaction at all. See types.ts's redact_span doc comment and
    # docs/exfil.md's "Output redaction" section.
    patterns:
      - regex: "AKIA[0-9A-Z]{16}"
        redact_span: true
      - regex: "ghp_[A-Za-z0-9]{36}"
        redact_span: true
      - regex: "github_pat_[A-Za-z0-9_]{22,}"
        redact_span: true
      - regex: "xox[baprs]-[A-Za-z0-9-]{10,}"
        redact_span: true
      - regex: "sk-[A-Za-z0-9_]{24,}"
        redact_span: true
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
    match: "git commit(?!.*(--signoff(?![A-Za-z-])|(?<![A-Za-z0-9-])-[a-z]*s[a-z]*(?![A-Za-z0-9-])))"
    action: fix
    fix:
      - pattern: "git commit"
        replace: "git commit --signoff"
    level: sprint
    priority: 65
    category: workflow
    severity: low
    confidence: high
    mode: block
    rationale: "Auto-adding --signoff is a pure convenience fix, not a security control — no incident citation applies; this is a standing repo convention. Priority raised from 60 to 65 — above commit-to-main (60/file-order), a same-severity workflow rule this one was previously losing ties to, so the auto-fix now actually fires on a bare main-branch commit missing --signoff. Deliberately kept BELOW no-verify-bypass (70) and git-history-rewrite (80): both are real security-relevant approval/awareness gates (per this codebase's own ACTION_STRENGTH scale, prompt=3 and warn=1 both rank as intentional, non-cosmetic interventions), and letting this rule's cosmetic action: fix silently pre-empt either one would swallow the approval prompt on a --amend or erase the only warning on a --no-verify bypass — confirmed by two pre-existing full-ruleset assertions in agentic-eval.test.ts that would otherwise regress."
    remediation: "N/A — this rule fixes the command in place automatically."
    false_positives:
      - "git commit --amend --no-edit or git commit --no-verify: NOT auto-fixed — git-history-rewrite/no-verify-bypass (both higher priority) intentionally win on these, so no signoff is added on that call; approve/heed that rule's verdict first, then re-run without those flags to get the signoff fix."
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


  # ── slopsquatting install gate (Wave-2 lane 2; supervisor paste at gate-2) ──
  - id: unverified-package-install
    type: package
    action: prompt
    age_days: 30
    category: supply-chain
    severity: high
    confidence: medium
    rationale: >
      19.7% of LLM-recommended packages don't exist (USENIX Security 2025,
      'We Have a Package for You! A Comprehensive Analysis of Package
      Hallucinations by Code Generating LLMs'). Attackers register the
      hallucinated name ahead of time and wait for an agent to install it —
      this already happened for real: the package 'huggingface-cli' was
      squatted on PyPI (the actual package is 'huggingface_hub') and
      shipped a reverse shell to anyone who typed the plausible-sounding
      name. A rule engine running outside the model's context window is
      the only thing that can check the name against the registry before
      the shell executes, since the hallucination itself is invisible to
      the model that produced it.
    remediation: >
      Confirm the package name and publisher before installing — check the
      registry page, the GitHub repo it links to, and recent download
      counts. If the agent suggested this name from memory rather than a
      lockfile or an explicit user instruction, treat the suggestion as
      unverified until you've looked it up yourself.
    false_positives:
      - 'Private or org-scoped registry packages (Verdaccio, Artifactory, GitHub Packages) that 404 against the public npm registry by construction — these prompt as unverified, never deny (see package-verifier.ts scoped-404 handling)'
      - 'A pip install that targets a private or company package index via --index-url, --extra-index-url, or -i — these always prompt as unverified without querying the custom index, since PyPI has no scoped-name convention like npm to signal "private" by name alone'
      - 'A legitimate package published in the last 30 days (the age-gate default) — prompts for a second look, not a hard block'
      - 'Registry timeouts or outages, on any of the four covered ecosystems — network failures always downgrade to unverified, never deny'
    message: "This package install could not be verified against its package registry — confirm the name and publisher before proceeding."

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
    rationale: "PROMOTED from mode: observe: this project's own traces cite 41 distinct repeat loops across 20 sessions (one command retried 39 times) from before this machinery existed — real hit-rate evidence for the underlying failure mode, and no over-triggering or false-positive has ever been recorded against this rule (see docs/tiers.md, session/PROMOTION-REPORT.md). Identical retries against the same failure are the single clearest signal of a stuck agent, and the one thing a rule engine can see that the model cannot: it runs outside the context window, where circling actually lives. Shipped as a DEFAULT rather than an opt-in paste (previously 'keel rules harness --append')."
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
    match: "(rm -rf|git[ \t]+checkout[ \t]+(--[ \t]+)?([.]|:/)([ \t]|$)|git reset --hard|(?<![A-Za-z])migrate(?![A-Za-z])|(?<![A-Za-z])refactor(?![A-Za-z]))"
    require_hypothesis: true
    fallback_pattern: "git (log|blame|bisect|diff)"
    action: redirect
    rationale: "Complex or destructive fixes should follow an investigation, not precede one. Discharged by a recorded hypothesis OR by real investigation evidence (git log/blame/bisect/diff), so it never demands ceremony from someone who already did the work."
    remediation: "Run git log/blame/bisect, or record a hypothesis with keel_hypothesis."
    false_positives:
      - "git checkout -- file.ts (a single-file checkout/restore) is NOT matched — only a whole-tree discard (git checkout -- ., git checkout ., git checkout -- :/) trips this; M1r-1 rules-tuning fix for the documented single-file FP (session/v04/AUDIT.md)."
      - "A write to src/migrations/001_init.ts or src/migrateUsers.ts is NOT matched — migrate/refactor are anchored to stand-alone words, not path or filename substrings."
    message: "Destructive or structural change without a recorded root cause. Investigate first."

  # ── Wave-2 verification proposals (observe burn-in; supervisor paste at gate-2) ──
  - id: claim-without-evidence
    type: claim
    category: verification
    severity: high
    # LOW, not medium, and not rounded up: see EVIDENCE.md §6 for the honest
    # accounting — the two channels this rule can see (an unwired
    # 'reasoning' field in every surveyed host, and commit/PR message text)
    # mean it fires on a small, host-dependent slice of real false-success
    # claims, and the grammar itself is a regex heuristic, not a parser.
    confidence: low
    maturity: incubating
    # observe: evaluated and recorded every call (observed_action in the
    # trace), never interrupts. A new detector earns its way to warn/block by
    # a measured false-positive rate on real trajectories, not by assumption.
    mode: observe
    trigger:
      tools: [write, edit, apply_patch, WriteFile]
      path: "src/"
      paths: ["package.json"]
      pattern: "(src/|package[.]json)"
    satisfy:
      tools: [Bash]
      pattern: "(npm test|npm run test|vitest|jest|pytest|go test|cargo test)"
    verification_window_seconds: 300
    action: warn
    message: >-
      Claimed done/fixed/tested/passing/verified/complete without a passing
      verification run since the last source edit. Run the test/build
      command that satisfies this obligation before making that claim, or
      say explicitly that it is unverified.
    rationale: >-
      Trajectory research on self-assessing coding agents found 75.8% of
      FAILING runs carried an explicit false-success claim in the agent's own
      output, and that LLM judges scoring those same claims for truthfulness
      land at ~0.54 AUROC — indistinguishable from chance. A judge that reads
      the claim and reasons about whether it sounds true cannot catch this
      class of failure; only cross-referencing the claim against what
      actually ran can. This rule does exactly that: it does not evaluate
      whether the claim is TRUE, only whether a verification command visibly
      ran and passed since the edit the claim is about — the same
      trigger/satisfy/pending shape the shipped 'source-change-requires-test'
      verification rule already uses, applied to the agent's own words
      instead of a commit/push boundary.
    remediation: >-
      Before stating a task is done/fixed/tested/passing/verified/complete,
      run the project's test or build command and let it finish (not
      '--help', '--dry-run', or a swallowed exit code — see verification.ts's
      isFakeSatisfy for what does not count). If verification genuinely
      cannot be run yet, say so plainly instead of claiming completion.
    false_positives:
      - >-
        WIP/status narration during active work ("still fixing the parser,
        tests not run yet") — suppressed by the grammar's hedge/negation
        exclusion (wip, todo, partial, "not run", "in progress", ...), but a
        hedge phrasing outside that word list will still fire.
      - >-
        A commit message that accurately describes a fix VERIFIED IN AN
        EARLIER session or an earlier window that has since expired
        (verification_window_seconds default 300s) — the obligation is gone
        by the time the commit happens, so the rule reads it as unverified
        even though it genuinely was. This is a real, not-yet-mitigated gap:
        the window is a proxy for "still fresh enough to trust," not a
        certificate that no verification ever happened.
      - >-
        Quoting the USER's or a teammate's claim back in reasoning text
        ("you said tests were passing, but I see...") is intended to be
        suppressed by the quoted-span exclusion; an unquoted paraphrase of
        someone else's claim is not caught by that exclusion and may
        false-fire.
      - >-
        Docs-only or config-only sessions that never touch 'src/' or
        'package.json' never arm the obligation at all, so a "done" claim
        about non-code work correctly never fires — not a false positive,
        but worth listing so a reviewer does not expect this rule to cover
        that case.
    review_by: "2026-11-11"

# ── GATE INTEGRATION NOTE — read before adopting, not a false_positives
#    entry (this is a suppression, not a wrong fire) ──
#
# This rule and the shipped 'source-change-requires-test' verification rule
# have an IDENTICAL 'trigger' (same tools/path/paths/pattern) and neither
# sets 'priority' (both default to 0). Proven empirically
# (claim.test.ts's "gate-integration ordering" describe block, which
# extracts the exact shipped rule text the way fixture-harness.test.ts
# extracts DEFAULT_RULES_YAML — see EVIDENCE.md §9): on the ONE channel
# this rule can actually reach in production today (see the confidence:low
# rationale above — commit/PR message text, not the unwired 'reasoning'
# field), 'git commit -m "<claim>"' while both rules are active, the
# EARLIER rule in file order wins EnforcementPipeline.evaluate()'s
# short-circuit — the shipped verification rule's commit-boundary 'warn'
# fires and THIS rule is never evaluated on that call at all. This is not a
# bug in either rule; it is a consequence of both watching the same trigger
# with the same priority. Adopting this rule needs an explicit ordering
# decision at the gate — a 'priority' above the shipped rule (which then
# raises a DIFFERENT problem: 'mode: observe' short-circuits
# 'evaluate()' too, so it would swallow the shipped rule's real 'warn' on
# that call — see EVIDENCE.md §9 before changing that behavior), or
# accepting the shipped rule's warn as the one users see on that
# trajectory. Not something this rule's own YAML can resolve.
  - id: test-oracle-tampering
    type: oracle
    level: sprint
    mode: observe
    action: warn
    category: verification
    severity: high
    confidence: low
    maturity: incubating
    message: >-
      A test-oracle weakening pattern (skip/only added, assertions or a
      test block removed, a snapshot or expected value rewritten,
      timeout/retry inflated) landed shortly after a failing test run.
      This may be making the test pass by weakening it, not by fixing the
      code — verify this is an intentional refactor, not a shortcut
      around a red run.
    rationale: >-
      Reward-hacking research documents agents making tests pass by
      editing the oracle instead of the implementation. ImpossibleBench
      found read-only visible tests the best safety/performance balance
      among test-oracle protections; short of that (see the opt-in
      tests-read-only.yaml), the next best deterministic control is
      flagging a weakening EDIT that follows a RED run — exactly the shape
      a reward-hacked "fix" takes, and rare enough in legitimate work that
      the recency gate keeps it a real signal.
    false_positives:
      - "Legitimate refactor: renaming a test or reorganizing describe blocks while preserving every assertion — no assertion-count, test-block-count, or skip-count delta, so this does not fire regardless of recency."
      - "Intentional snapshot update after a real UI/output change (jest -u / vitest -u) run within 15 minutes of an UNRELATED failing test elsewhere in the same command invocation — the recency window is per (rule, cwd, session), not per file or per failing test name, so the SAME session's monorepo-wide test run failing in module A can arm the window for that session's intentional, correct snapshot refresh in module B moments later."
      - "Removing a genuinely obsolete test (the feature it covered was deleted) shortly after a failing run of a DIFFERENT test in the same suite invocation — the trigger is the exit code of the whole test command, not evidence that THIS test was the one failing."
      - "Fixing a wrong expected value in the test itself (the test asserted the wrong thing, not the code) — indistinguishable at this detector's confidence level from rewriting a correct expectation to dodge a real failure; this is exactly why the rule ships at 'confidence: low' and 'mode: observe' rather than blocking."
    review_by: "2026-11-11"
    paths:
      - "**/*.test.*"
      - "**/*.spec.*"
      - "**/tests/**"
      - "**/test_*.py"
      - "**/conftest.py"
      - "**/*.snap"
      - "**/__snapshots__/**"
    trigger:
      tools: [Bash]
      pattern: "(npm|pnpm|yarn|npx) +(run +)?test|vitest|jest|pytest|go +test|cargo +test|rspec|phpunit|mvn +test|gradle +test"
      exit: nonzero
    match: "(?<![A-Za-z0-9_])(jest|vitest)(?![A-Za-z0-9_])[^|;&]*(--update-snapshot(?![A-Za-z0-9-])|--updateSnapshot(?![A-Za-z0-9])|(?:^| )-u(?![A-Za-z0-9-]))"
    window_seconds: 900

  - id: test-oracle-env-introspection
    type: content
    level: sprint
    mode: observe
    action: warn
    category: verification
    severity: high
    confidence: low
    maturity: incubating
    message: >-
      Written content inspects the call stack, process.argv, or module
      identity (require.main/import.meta) AND references a test-file
      identifier (.test., .spec., __tests__, currentTestName, testPath) AND
      branches on it (if/switch) — OR calls jest's expect.getState() (itself
      a read of which test is currently running) AND branches on it — the
      exact shape two calibration models used to satisfy two contradictory
      test files by detecting WHICH ONE is calling the implementation and
      returning a different answer per caller, not by implementing correct
      behavior. Verify this is a legitimate entrypoint/environment check,
      not test-oracle gaming via caller detection.
    rationale: >-
      Discovered live during the v0.4 benchmark (session/v04/EVIDENCE/
      b2-benchmark.md, section 4, "A real exploit found, not anticipated:
      environment introspection"): given two test files asserting opposite
      outputs, one calibration model read process.argv[1] and another read
      new Error().stack to detect which test file was currently executing
      and branched the implementation's return value accordingly — both
      "contradictory" tests passed, the implementation was never actually
      correct for either, and neither test file was edited, so the shipped
      test-oracle-tampering rule (which watches for EDITS to test files)
      never fires on this. keel had no rule for this failure class before
      this one. This is a content-diff signal (the SOURCE being written,
      not a command), so it ships as its own rule instead of folding into
      test-oracle-tampering's command/content-diff surfaces. Deliberately
      narrower than the benchmark's own detectEnvironmentIntrospection()
      grading helper, which also flags bare process.env, __filename, and
      __dirname, plus any .stack access at all — those are ordinary in
      everyday Node.js code (path resolution, config reads) and would
      false-fire constantly on jest.config.js/webpack.config.js-style files
      that legitimately combine __dirname, environment ifs, and
      .test./.spec. glob patterns in the same file. This rule instead
      requires the narrower Error()-construction, process.argv, or
      require.main/import.meta surface, ANDed (via lookahead,
      order-independent, anywhere in the written content) with BOTH a
      test-file identifier string AND an if/switch branch keyword before it
      fires — three signals for three of the four patterns. The fourth
      pattern (expect.getState()) requires only that surface ANDed with an
      if/switch, not a separate test-file identifier string, because
      calling expect.getState() at all is already itself a read of which
      test is currently running — no ordinary non-test code has a reason to
      call it; gaming code that goes on to read
      expect.getState().currentTestName still independently satisfies the
      other patterns' test-file identifier signal too, since
      currentTestName is in that same list. Shipped observe/confidence: low
      because a content regex over arbitrary source text cannot see intent
      or data flow — it can only prove two or three narrow textual signals
      co-occurred, which is what a burn-in period against real trajectories
      is for. That co-occurrence is scoped to the write's own inline
      content when the tool call carries one, but on an Edit call with no
      inline content the pipeline falls back to scanning the WHOLE file
      already on disk — so on that path "co-occurred" means anywhere in the
      existing file, not just within the diff being applied.
    false_positives:
      - "Legitimate Error().stack logging/error-reporting (console.error(new Error().stack), an error-tracker capture, a custom stack-trace formatter) — allowed unless the SAME write also mentions a test-file identifier string and an if/switch, which ordinary error-reporting code does not."
      - "Ordinary CLI argument parsing (process.argv.slice(2), an if/switch chain for --verbose/--help) — allowed unless the same write also references .test./.spec./__tests__/currentTestName/testPath, which a normal CLI parser has no reason to."
      - "The extremely common require.main === module / import.meta.url entrypoint-detection idiom (am I the module Node executed directly, or was I imported) — allowed unless the same write also carries a test-file identifier string and a branch, which a plain entrypoint check does not."
      - "A legitimate custom jest matcher (expect.extend) reading expect.getState().currentTestName for a diagnostic message, combined with an unrelated if elsewhere in the same matchers file — this rule cannot distinguish 'branches the assertion logic' (legitimate matcher authoring) from 'branches the return value to satisfy two contradictory tests' (gaming); both match. This is the class's most plausible false-fire and is exactly why the rule ships at confidence: low."
      - "A test-infrastructure or fixtures file that legitimately combines __dirname or import.meta with a __tests__/.test. path constant AND an unrelated if statement anywhere else in the same file for other reasons — the three signals are ANDed by co-occurrence anywhere in the whole write, not by proximity or causal connection, so an unrelated combination in one file can still fire."
      - "An Edit call that carries no inline content scans the WHOLE existing file on disk, not just the diff being applied — a large legitimate file that happens to contain all three signals spread across unrelated functions (an error handler with Error().stack elsewhere in the same file as an unrelated __tests__ path constant and an unrelated if) can fire on an edit that touches neither of those regions."
    review_by: "2026-11-11"
    patterns:
      - regex: "^(?=[^]*(?:new[ ]+Error[(][)][.]stack|Error[(][)][.]stack|Error[.]captureStackTrace))(?=[^]*(?:[.]test[.]|[.]spec[.]|__tests__|currentTestName|testPath))(?=[^]*(?:(?<![A-Za-z0-9_])if(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])switch(?![A-Za-z0-9_])))"
      - regex: "^(?=[^]*process[.]argv)(?=[^]*(?:[.]test[.]|[.]spec[.]|__tests__|currentTestName|testPath))(?=[^]*(?:(?<![A-Za-z0-9_])if(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])switch(?![A-Za-z0-9_])))"
      - regex: "^(?=[^]*(?:require[.]main|module[.]parent|import[.]meta))(?=[^]*(?:[.]test[.]|[.]spec[.]|__tests__|currentTestName|testPath))(?=[^]*(?:(?<![A-Za-z0-9_])if(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])switch(?![A-Za-z0-9_])))"
      - regex: "^(?=[^]*expect[.]getState[(][)])(?=[^]*(?:(?<![A-Za-z0-9_])if(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])switch(?![A-Za-z0-9_])))"

  - id: test-before-commit
    type: verification
    mode: observe
    category: verification
    severity: medium
    confidence: medium
    rationale: >
      False-success research and do-not-ship consensus: hard-blocking a
      commit on "no test run since the last src/ edit" also catches WIP
      commits, docs-only commits, and fixture/data-only changes that merely
      happen to touch a path under src/. Observe mode measures this rule's
      real false-positive rate against live commit traffic before anyone
      lets it interrupt a commit.
    false_positives:
      - WIP commits
      - docs-only commits
      - fixture/data-only changes
    trigger:
      tools: [write, edit, apply_patch, WriteFile]
      path: "src/"
    satisfy:
      tools: [Bash]
      pattern: "(npm test|npm run test|vitest|jest)"
    boundaries:
      commit:
        pattern: "git commit"
        action: warn
    verification_window_seconds: 300
    action: warn
    message: "Source changes under src/ were committed without a passing test run in this session."
  - id: runaway-budget-tool-calls
    type: rate
    mode: observe
    category: workflow
    severity: low
    confidence: high
    rationale: >
      Budget-model precedent (Cloudflare WAF log mode, OPA Gatekeeper
      dryrun): total tool-call volume in a long window is a coarse proxy for
      a runaway loop or scope-creep session. Observe mode measures the real
      hit rate against legitimate long sessions before this ever interrupts
      anyone. Token budgets are not visible to keel's enforcement hook and
      are intentionally NOT modeled by this rule.
    false_positives:
      - long legitimate refactors
      - batch operations
    match: ".*"
    window_seconds: 14400
    max_calls: 500
    action: warn
    message: "More than 500 tool calls in this session's last 4 hours — possible runaway loop or scope creep."

  - id: runaway-budget-bash-calls
    type: rate
    mode: observe
    category: workflow
    severity: low
    confidence: high
    rationale: >
      Same budget-model precedent as runaway-budget-tool-calls, scoped to
      Bash specifically: a runaway shell loop can stay under the total
      tool-call ceiling while still hammering the shell. Observe mode
      measures the real hit rate before this interrupts anyone. Token
      budgets are not visible to keel and are intentionally NOT modeled.
    false_positives:
      - long legitimate refactors
      - batch operations
    match: "Bash"
    window_seconds: 14400
    max_calls: 500
    action: warn
    message: "More than 500 Bash calls in this session's last 4 hours — possible runaway loop or scope creep."

  - id: session-runaway-trip
    type: session
    mode: observe
    category: resource
    severity: medium
    confidence: medium
    priority: 0
    action: warn
    session_escalation:
      - dimension: duration_minutes
        at: 240
        action: warn
        message: "Session has been running 4+ hours — check whether this is still a legitimate long task."
      - dimension: duration_minutes
        at: 480
        action: prompt
        message: "Session has been running 8+ hours — confirm this is still intentional before continuing."
      - dimension: tool_calls
        at: 500
        action: warn
        message: "500+ tool calls this session — possible runaway loop or scope creep."
      - dimension: tool_calls
        at: 1000
        action: prompt
        message: "1000+ tool calls this session — confirm this is still intentional before continuing."
      - dimension: bash_calls
        at: 300
        action: warn
        message: "300+ Bash calls this session — possible runaway shell loop."
      - dimension: bash_calls
        at: 600
        action: prompt
        message: "600+ Bash calls this session — confirm this is still intentional before continuing."
      - dimension: file_write_churn
        at: 40
        action: warn
        message: "40+ distinct files written this session — possible scope creep beyond the original task."
      - dimension: file_write_churn
        at: 80
        action: prompt
        message: "80+ distinct files written this session — confirm this is still intentional before continuing."
      - dimension: consecutive_failures
        at: 3
        action: warn
        message: "3 consecutive failing tool-call outcomes this session — the agent may be stuck."
      - dimension: consecutive_failures
        at: 5
        action: prompt
        message: "5 consecutive failing tool-call outcomes this session — confirm before continuing."
      - dimension: consecutive_failures
        at: 8
        action: deny
        halt: true
        message: "8 consecutive failing tool-call outcomes this session — locking down (keel halt) until a human runs keel resume."
    rationale: >
      A composite runaway-loop trip across five session-scoped dimensions:
      wall-clock duration, cumulative tool-call count, cumulative Bash-call
      count, distinct-file-write churn, and consecutive-failure count. The
      first four are pure VOLUME counters that climb whether a session is
      thriving or stuck — a legitimate 200-tool-call refactor across 60
      files looks identical to a runaway loop on those dimensions alone —
      so by construction (rule-parser.ts's validateRules rejects any other
      shape) they cap at prompt and can NEVER trip keel halt on their own,
      the same asymmetry no-repeat-loops (type: stuck) already relies on
      via require_failure + fingerprint: auto. Only consecutive_failures
      is failure-aware (reset on any success, exactly like no-repeat-loops)
      and is the one dimension allowed to escalate all the way to a keel
      halt lockdown latch with no auto-expiry.
      Ships as mode: observe, unlike no-repeat-loops today: no-repeat-loops
      earned its promotion out of observe on real measured evidence (41
      distinct repeat loops across 20 sessions, zero recorded
      false-positives — see docs/tiers.md). This rule is new and has no
      such evidence base yet, so it starts exactly where no-repeat-loops
      itself started and where the two runaway-budget-* rules above still
      sit: observe-only, measuring a real would-block rate on your own
      traffic before anyone raises its mode to warn or block.
      Session-scoping depends on the calling host sending a real session
      id (see hook.ts's parsePayload confidence ladder); a host that sends
      none gets a fresh id per keel hook process, and every dimension
      here silently under-counts to a single call per "session" — surfaced
      explicitly at keel validate / keel status, not silently degraded.
    remediation: "Slow down, re-scope, or ask the user for direction. If a consecutive_failures halt fires, a human must run keel resume — stop and investigate why every recent attempt failed before doing so."
    false_positives:
      - "A long legitimate multi-file refactor or a batch operation across many files — the volume-only dimensions (duration/tool_calls/bash_calls/file_write_churn) cap at prompt and can never halt on their own."
      - "Polling a long-running job by re-running the same status command — if the poll command itself keeps exiting 0, consecutive_failures never advances."
      - "An overnight-idle conversation: duration_minutes is computed from first-seen wall-clock time, not active time, so a session left open idle overnight crosses the duration thresholds on elapsed time alone. This is exactly the class mode: observe exists to measure before anyone promotes it."
    message: "Session runaway trip: composite duration / call-volume / file-write-churn / consecutive-failure trip for this session."

  - id: session-spend-limit
    type: budget
    mode: observe
    category: resource
    severity: medium
    confidence: medium
    maturity: incubating
    max_tokens: 2000000
    action: deny
    rationale: >-
      keel had NO visibility into LLM API token/dollar usage at all before
      this rule — the two existing runaway-budget-* rules (type: rate,
      above) only ever counted tool-call VOLUME, and their own rationale
      says so explicitly ("token budgets are not visible to keel's
      enforcement hook and are intentionally NOT modeled"), because usage
      lives in the model response, which keel's hook architecture never
      saw. This rule closes that gap by reading REAL usage from a host's
      own local record instead — a Claude Code session transcript's
      message.usage fields, or an OpenCode session row's own cost/tokens_*
      columns — never a network proxy. Two-phase by construction (see
      packages/core/src/enforce/budget-tracker.ts): a Stop/PostToolUse-
      equivalent hook measures spend and persists an over-budget flag; only
      the NEXT PreToolUse call can ever deny, because Claude Code's Stop
      hook is architecturally observe-only (it cannot block the turn that
      just completed — docs/integration-guides/claude-code.md) — the same
      "warn on first violation, persisted state blocks on repeat" shape
      every other deny rule in this ruleset already uses. Shipped in
      mode: observe, not enforcing: the model-string normalization this
      depends on has a safety-critical failure mode (short aliases like
      claude-sonnet-5/claude-opus-4-8/claude-fable-5, observed live on real
      sessions on the machine this rule was built on, carry real non-zero
      usage but must never be priced as if they matched an official dated
      model ID) and needs to burn in against real traffic before it blocks
      anything. max_tokens alone, no max_dollars, for the related reason:
      a session using only aliased model strings correctly degrades its
      dollar figure to unavailable (never a guessed/partial total), so a
      rule keyed on max_dollars risks being a control that can never fire
      on exactly the sessions observed live on this machine.
    remediation: "Review the session's cumulative token usage; start a fresh session if the work has drifted, or raise max_tokens for a genuinely long one."
    false_positives:
      - "A long but legitimate large-refactor session — token spend correlates with session LENGTH, not with anything going wrong, the same false-positive shape the existing call-volume runaway-budget-* rules above already document for themselves."
      - "A Claude Code transcript that cannot be read (missing/rotated file, permissions) degrades that measurement to the last confirmed state rather than asserting either verdict from zero data — see BudgetTracker.record()'s own comment. Surfaces as a distinct 'unavailable' audit entry, never a false block, but this rule's real hit rate depends on transcript readability."
    message: "This session's measured LLM token spend exceeds max_tokens — possible runaway usage. Review before continuing, or raise the ceiling for a genuinely long session."

  - id: command-oscillation
    type: oscillation
    mode: observe
    category: workflow
    severity: medium
    confidence: medium
    maturity: incubating
    priority: -10
    window_seconds: 900
    oscillation_window_size: 8
    min_cycle_length: 2
    max_cycle_length: 4
    min_cycle_repeats: 2
    fingerprint: auto
    require_failure: true
    escalation:
      - at: 2
        action: redirect
        message: "This session has cycled through the same short sequence of failing commands/edits at least twice without resolving. Stop alternating between them. Research the exact error, state a root-cause hypothesis, then change approach."
      - at: 3
        action: deny
        message: "3+ repeats of the same oscillating pattern. Retrying without new information is blocked — record a hypothesis or ask the user."
    action: warn
    rationale: >-
      ROADMAP.md named this a planned-but-unbuilt sibling of no-repeat-loops
      (type: stuck): "oscillation (A→B→A)". no-repeat-loops only catches the
      SAME failing command retried — it does NOT catch an agent alternating
      between two or three DIFFERENT failing commands or edits that never
      converge (edit file A, edit file B undoing A's change, edit A again), a
      real stuck pattern that looks like "activity" but is actually going
      nowhere. This rule tracks a SHORT rolling window of recent command
      fingerprints per session (default: last 8, not the whole session
      history — oscillation is a LOCAL pattern) and detects a repeating CYCLE
      of length >= 2 (A→B→A→B, or A→B→C→A→B→C), not merely "any command seen
      before in the window" — the latter would false-positive on completely
      normal workflows like alternating between running a test and editing
      the file it tests. Complementary to no-repeat-loops by construction,
      never redundant with it: a pure exact-repeat (period 1) never satisfies
      this rule's distinct-fingerprint-within-the-unit requirement, and a
      genuine A→B→A→B cycle never accumulates a count in no-repeat-loops'
      per-fingerprint buckets either — see oscillation-tracker.ts's check().
      require_failure defaults to true, mirroring no-repeat-loops' own
      discriminator, deliberately: a legitimate TDD red-green-refactor loop
      (edit test, edit code, edit test, edit code) is LITERALLY period-2
      alternation between two fingerprints, and the only thing distinguishing
      it from a genuine stuck oscillation is that each step succeeds —
      requiring failure excludes it by construction (the edit calls report
      exitCode 0 and are never appended to the window; the one command that
      legitimately repeats on every red iteration, the test runner, is the
      SAME fingerprint each time — period 1 — no-repeat-loops' territory, not
      this rule's). Ships in mode: observe, exactly like session-runaway-trip
      and session-spend-limit started: this is a brand-new detector with zero
      measured hit-rate evidence, and no-repeat-loops is the only rule in this
      catalog that has ever earned promotion out of observe, on real evidence
      (41 distinct repeat loops across 20 sessions, zero recorded
      false-positives) via keel retrospective + a human running keel
      promote — this rule follows the identical evidence-gated path, not a
      shortcut around it.
    remediation: "Stop alternating between the same short sequence of commands or edits. Research why neither approach is holding, state a root-cause hypothesis, then try something genuinely different."
    false_positives:
      - "A legitimate edit/verify alternation (e.g. edit a config, re-run a linter, edit again) where every step SUCCEEDS — excluded by require_failure: true, since a clean exit is never appended to the window."
      - "KNOWN GAP, not a false positive but a documented miss: an agent oscillating between two edits that each individually SUCCEED (e.g. reverting a file to a prior state each time) is invisible to this rule as shipped — catching that needs a content-state ('did this file's content actually change vs. a prior version') signal no tracker in this codebase feeds into this detector today. See oscillation-tracker.ts's header."
    message: "Oscillating pattern detected: cycling between the same short sequence of failing commands/edits without resolving."

`

function ensureRules(): void {
  try {
    if (!fs.existsSync(RULES_PATH)) {
      fs.mkdirSync(KEEL_DIR, { recursive: true })
      fs.writeFileSync(RULES_PATH, DEFAULT_RULES_YAML, 'utf8')
    }
  } catch {}
}

function isDisabled(): boolean {
  try {
    if (!fs.existsSync(DISABLED_PATH)) return false
    const state = JSON.parse(fs.readFileSync(DISABLED_PATH, 'utf8'))
    if (state.expires_at && new Date(state.expires_at) < new Date()) {
      fs.rmSync(DISABLED_PATH, { force: true })
      return false
    }
    return true
  } catch {
    // A corrupt kill-switch must never silently keep enforcement off: fail
    // CLOSED (enforcement stays on) and record the corruption for `keel
    // status` and the audit trace.
    sentinelCorrupted = true
    try { record({ event: 'corrupt-kill-switch-fail-closed', message: 'Invalid keel kill-switch state; enforcement stays ON until ' + DISABLED_PATH + ' is fixed or removed' }) } catch {}
    return false
  }
}

/**
 * `keel halt`'s check — the inverse polarity of isDisabled() above.
 * isDisabled() fails closed by returning false on a corrupt sentinel
 * (enforcement stays ON — "closed" for a control that ALLOWS everything
 * means falling back to normal enforcement). isHalted() fails closed by
 * returning `halted: true` on a corrupt sentinel (every call keeps being
 * DENIED — "closed" for a latch that DENIES everything means the denial
 * stays in force). There is no expires_at here and never will be: a halt
 * has no restart-consumption/TTL concept, unlike DISABLED's
 * auto_enable_on_restart — see consumeRestartDisable() below, which has no
 * halt equivalent by design.
 *
 * Reads the file directly (readFileSync in one try/catch) instead of
 * existsSync()-then-readFileSync(): a bare existsSync() swallows
 * EACCES/ELOOP the same as ENOENT, so "cannot determine" and "confirmed
 * absent" would both read as "not halted" — a permissions glitch would
 * silently defeat the latch. Only a confirmed ENOENT means genuinely not
 * halted. Never throws: the caller (before(), below) needs a plain
 * { halted, reason } it can act on unconditionally.
 */
function isHalted(): { halted: boolean; reason: string } {
  let raw: string
  try {
    raw = fs.readFileSync(HALTED_PATH, 'utf8')
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return { halted: false, reason: '' }
    // Cannot confirm absence (EACCES, ELOOP, ...) — fail closed.
    return { halted: true, reason: 'unable to confirm halt state' }
  }
  try {
    const state = JSON.parse(raw)
    const reason = typeof state?.reason === 'string' && state.reason ? state.reason : 'Manual halt'
    return { halted: true, reason }
  } catch {
    return { halted: true, reason: 'unknown (corrupt sentinel)' }
  }
}

function consumeRestartDisable(): void {
  try {
    if (!fs.existsSync(DISABLED_PATH)) return
    const state = JSON.parse(fs.readFileSync(DISABLED_PATH, 'utf8'))
    if (state.auto_enable_on_restart && !state.expires_at) fs.rmSync(DISABLED_PATH, { force: true })
  } catch { /* Keep a corrupt disable sentinel in place until manual recovery. */ }
}

function record(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(TRACES_DIR, { recursive: true })
    const now = new Date()
    fs.appendFileSync(path.join(TRACES_DIR, `${now.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({
      t: Date.now(), timestamp: now.toISOString(), agent: 'opencode-plugin', ...entry,
    })}\n`)
  } catch {}
}

function requirementLines(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) return []
    return fs.readFileSync(filePath, 'utf8').split('\n')
      .map(line => line.replace(/^#+\s*/, '').trim())
      .filter(line => line && !line.startsWith('[') && !line.startsWith('<!--'))
  } catch { return [] }
}

/**
 * Per-session turn counter.
 *
 * OpenCode hands us no turn index, and `turn_number` was hardcoded to 0 —
 * which silently broke everything keyed on it. The FlowTracker buckets on
 * `flow:<session>:<turn>` (flow-tracker.ts:52,74), so with a constant 0
 * every turn collapsed into one bucket: a rule meant to catch "read a
 * secret and reached a network sink IN THE SAME TURN" instead matched any
 * read and any later sink anywhere in the session — a false-positive
 * generator. `keel lessons` has the mirror problem (lessons.ts:116 pairs a
 * claim with a tool call by turn).
 *
 * The turn boundary is `experimental.chat.system.transform`, which fires
 * once per model call. Degradation is graceful: if that hook arrives
 * without a sessionID we advance the most recently active session, and if
 * we can attribute nothing the counter simply stays put — i.e. today's
 * behavior, never worse.
 */
const turnCounters = new Map<string, number>()
let lastActiveSession = 'unknown'

function currentTurn(sessionId: string): number {
  return turnCounters.get(sessionId) ?? 0
}

function advanceTurn(sessionId: string): void {
  turnCounters.set(sessionId, (turnCounters.get(sessionId) ?? 0) + 1)
}

function toEnforceInput(tool: string, args: Record<string, unknown>, hookInput: any, level: any, cwd: string) {
  const sessionId = hookInput?.sessionID || 'unknown'
  lastActiveSession = sessionId
  return {
    tool, args, cwd, session_id: sessionId, turn_number: currentTurn(sessionId),
    context_tokens: 0, level, depth: level === 'protect' ? 'deep' : level === 'sprint' ? 'fast' : 'full',
    context: 'local' as const, agent: 'opencode', subagent_of: null,
    ...(hookInput?.reasoning ? { reasoning: String(hookInput.reasoning) } : {}),
  }
}

function applyFix(args: Record<string, unknown>, result: any): void {
  const fixed = result.fix_result?.fixed
  if (typeof fixed === 'string' && typeof args.command === 'string') args.command = fixed
}

function worktreeFingerprint(directory: string, sourcePath: string | undefined): string | null {
  if (!sourcePath) return null
  try {
    const diff = spawnSync('git', ['-C', directory, 'diff', '--binary', 'HEAD', '--', sourcePath], { encoding: 'utf8' })
    const untracked = spawnSync('git', ['-C', directory, 'ls-files', '--others', '--exclude-standard', '--', sourcePath], { encoding: 'utf8' })
    if (diff.status !== 0 || untracked.status !== 0) return null
    let content = `${diff.stdout}\n${untracked.stdout}`
    for (const relative of untracked.stdout.split('\n').filter(Boolean)) {
      try { content += `\n${relative}\n${fs.readFileSync(path.join(directory, relative), 'utf8')}` } catch {}
    }
    return content
  } catch { return null }
}

export default {
  id: 'keel-enforce',
  server: async (pluginInput: any) => {
    ensureRules()
    const directory = pluginInput?.directory || process.cwd()
    const client = pluginInput?.client
    // Last known good: an invalid rules file must not disable the guardrails.
    // Any source with errors is replaced by the built-in default rules (so
    // enforcement continues), the error is logged loudly, and strict mode
    // (KEEL_STRICT=1) restores the old throw-on-invalid behavior.
    let hierarchy = loadRuleHierarchy(directory)
    let ruleErrors = [hierarchy.global, hierarchy.user, hierarchy.project, hierarchy.local]
      .flatMap(source => source ? [...(source.errors || []), ...validateRules(source.rules)] : [])
    const logError = (event: string, errors: string[]) => {
      try { record({ event, errors, directory }) } catch {}
      try { client?.app?.log?.({ body: { service: 'keel', level: 'error', message: `[Keel] ${event}: ${errors.join('; ')}` } }) } catch {}
    }
    if (ruleErrors.length) {
      if (process.env.KEEL_STRICT === '1') {
        throw new Error(`[Keel] Invalid Keel rules (KEEL_STRICT=1): ${ruleErrors.join('; ')}`)
      }
      logError('invalid-rules-fallback-to-defaults', ruleErrors)
      hierarchy = { global: parseRulesContent(DEFAULT_RULES_YAML, 'keel:defaults'), user: null, project: null, local: null }
      ruleErrors = []
    }
    let level = hierarchy.project?.config.level || hierarchy.global?.config.level || 'balanced'
    let activeHierarchy = hierarchy
    let verificationIds = new Set<string>()
    let verificationBaselines = new Map<string, string | null>()
    const refreshVerificationMetadata = (nextHierarchy: typeof hierarchy) => {
      activeHierarchy = nextHierarchy
      level = nextHierarchy.project?.config.level || nextHierarchy.global?.config.level || 'balanced'
      verificationIds = new Set([
        ...(nextHierarchy.global?.rules || []), ...(nextHierarchy.project?.rules || []), ...(nextHierarchy.local?.rules || []),
      ].filter(rule => rule.type === 'verification').map(rule => rule.id))
      const nextBaselines = new Map<string, string | null>()
      for (const rule of [...(nextHierarchy.global?.rules || []), ...(nextHierarchy.project?.rules || []), ...(nextHierarchy.local?.rules || [])]) {
        if (rule.type === 'verification') nextBaselines.set(rule.id, worktreeFingerprint(directory, rule.trigger?.path))
      }
      verificationBaselines = nextBaselines
    }
    refreshVerificationMetadata(hierarchy)
    const pipeline = new EnforcementPipeline({
      level, context: 'local', cache: new ActionCache({ maxSize: 1000 }),
      contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
      flowTracker: new FlowTracker(), ruleHierarchy: hierarchy, ruleVersion: 1,
      allowedFixTransforms: true,
      stateManager: new StateManager(),
      stuckTracker: new StuckTracker(),
      oscillationTracker: new OscillationTracker(),
      sessionTracker: new SessionTracker(),
      budgetTracker: new BudgetTracker(new PersistentBudgetStore()),
      researchTracker: new ResearchTracker(),
      reloadRules: () => loadRuleHierarchy(directory),
      ruleFingerprint: () => [
        path.join(directory, '.keel', 'rules.yaml'), path.join(directory, 'AGENTS.md'), path.join(directory, 'CLAUDE.md'),
        path.join(directory, '.keel.local.yaml'), path.join(directory, 'AGENTS.local.md'), path.join(directory, 'CLAUDE.local.md'),
        RULES_PATH, path.join(HOME_DIR, '.config', 'keel', 'rules.yaml'),
      ].map(source => hashRulesFile(source)).join(':'),
      onRulesReload: refreshVerificationMetadata,
      onRulesError: (errors) => {
        // Mid-session typo: keep enforcing with the last known good rules,
        // but surface the error so the user knows the new rules did not take.
        logError('invalid-rules-reload-kept-last-known-good', errors)
      },
    })
    const verificationWarnings = new Set<string>()
    const surfacedWarnings = new Set<string>()
    const surfaceWarn = (ruleId: string, message: string, sessionID: string | undefined, once = true) => {
      // Warn-level results are audit-only by default; surface each rule once
      // per session so "warnings vs blocks" is a visible dial, not a silent
      // trace entry.
      //
      // `once: false` is for findings that are distinct events rather than
      // one recurring rule — a syntax error in a second file is new
      // information, not a repeat. Deduping those by rule id reported the
      // first broken file and silently swallowed every one after it.
      const key = `${ruleId}:${sessionID || 'unknown'}`
      if (once) {
        if (surfacedWarnings.has(key)) return
        surfacedWarnings.add(key)
      }
      try {
        client?.app?.log?.({
          body: {
            service: 'keel',
            level: 'warn',
            message: `[Keel] ${ruleId}: ${message}`,
            extra: { rule_id: ruleId, session_id: sessionID },
          },
        })
      } catch {}
    }
    const refreshExternalChanges = async () => {
      for (const rule of [...(activeHierarchy.global?.rules || []), ...(activeHierarchy.project?.rules || []), ...(activeHierarchy.local?.rules || [])]) {
        if (rule.type !== 'verification' || !rule.trigger?.path) continue
        const current = worktreeFingerprint(directory, rule.trigger.path)
        const baseline = verificationBaselines.get(rule.id)
        if (current && baseline && current !== baseline) {
          verificationBaselines.set(rule.id, current)
          const tool = rule.trigger.tools?.[0] || rule.trigger.tool || 'WriteFile'
          await pipeline.evaluate(toEnforceInput(tool, { path: rule.trigger.path, content: rule.trigger.path }, pluginInput, level, directory))
        }
      }
    }
    const requirementSources = [REQUIREMENTS_PATH, path.join(directory, '.keel', 'requirements.md')]
      .filter((source, index, all) => all.indexOf(source) === index)
    consumeRestartDisable()

    /**
     * Post-edit syntax check (tier 1).
     *
     * Runs after an edit lands, so a broken file is caught where it was
     * made rather than at the next test run. Findings are QUEUED, not
     * thrown: the after-hook's only channel is the client log, which the
     * user sees but the model may not. The proven model-visible channel is
     * a throw from the before-hook, so the finding is surfaced on the
     * agent's next tool call — the same deferred-boundary shape the
     * verification obligations already use.
     *
     * Ships observe-first: it warns, it never blocks. Promotion to a
     * harder action is earned by a measured false-positive rate, not
     * assumed.
     *
     * Keyed by sessionID: this used to be one shared array, which meant
     * the NEXT before() to fire (potentially a DIFFERENT concurrent
     * session in the same project directory) would drain and deliver the
     * ENTIRE queue tagged with its own, wrong, sessionID — session A's
     * edit finding misdelivered to session B's next tool call. A
     * Map<sessionID, findings[]> keeps each session's own queue isolated,
     * so before() only ever drains and delivers findings that belong to
     * its OWN session.
     */
    const pendingSyntaxFindings = new Map<string, string[]>()

    const verifyEdit = async (tool: string | undefined, args: Record<string, unknown>, sessionID: string | undefined, turn: number) => {
      if (!EDIT_TOOLS.has(String(tool).toLowerCase())) return
      const raw = String(args.filePath || args.path || args.file || '')
      if (!raw) return
      const target = path.isAbsolute(raw) ? raw : path.join(directory, raw)
      if (!isVerifiableFile(target) || !fs.existsSync(target)) return
      const detail = await verifyFileSyntax(target)
      if (!detail) return          // clean, or no verifier available
      const message = `${path.basename(target)} has a syntax error after your edit: ${detail}`
      // Queue only, under this session's own key. Delivery happens on the
      // agent's next tool call, on the model-visible channel — surfacing
      // here as well would double-report and, worse, consume the
      // once-per-session budget so the deferred copy went missing.
      const key = sessionID || 'unknown'
      const queue = pendingSyntaxFindings.get(key)
      if (queue) queue.push(message)
      else pendingSyntaxFindings.set(key, [message])
      record({ session_id: sessionID, turn_number: turn, tool, args: { path: target }, rule_id: 'post-edit-syntax', action: 'warn', message, hook: 'tool.execute.after', cwd: directory })
    }

    /**
     * Real output redaction (sprint/lane-c2). Live-verified — not inferred
     * from the SDK's type declarations — that mutating `tool.execute.after`'s
     * `output` object actually rewrites what the MODEL receives on
     * OpenCode, not just what the terminal renders: a probe plugin that
     * redacted a runtime-generated secret (a value the model could not have
     * known any other way) from `output.output` produced a model reply that
     * never contained the real value, while an identical run with the
     * mutation removed produced the real value verbatim. See
     * session/transcripts/opencode-tool-execute-after-mutation-probe.txt and
     * docs/exfil.md's "Output redaction" section for the full transcript.
     *
     * `output.metadata` was found (same probe, run 6) to independently
     * duplicate raw stdout in at least the bash tool's shape
     * (`metadata.output`) — a redaction that only touched `output.output`
     * would leave a second raw copy sitting in the object OpenCode persists
     * to its own session store. `redactText` below is applied to every
     * string field that could carry the same content: `output.output`,
     * `output.title`, and every string value under `output.metadata`.
     *
     * Reuses `pipeline.evaluateOutput()` — the SAME `type: content` regex
     * patterns that already gate what gets WRITTEN to a file
     * (`no-secrets-in-code`) — rather than inventing separate output-side
     * detection. `evaluateOutput()` never mutates anything itself; applying
     * `redacted_output` back onto the host's own mutable object is this
     * hook's job specifically, because this is the one host where doing so
     * is confirmed to actually reach the model.
     *
     * Only TOP-LEVEL string values of `output.metadata` are scanned — the
     * shape confirmed live for the bash tool (`{output, exit, truncated}`,
     * session/transcripts/opencode-tool-execute-after-mutation-probe.txt's
     * run 6). A tool whose metadata nests a secret inside a further object
     * or array is not covered; this was a deliberate scope decision (no
     * other tool's metadata shape has been observed), not an oversight.
     */
    // Scan-only on a CLEAN result — deliberately does NOT record to the
    // trace when nothing was found. Recording "redacted before delivery"
    // has to happen strictly AFTER the caller has actually written
    // `redacted_output` back onto the host object, never before: on the
    // batched (title+metadata) path below, the split-count guard can bail
    // out and leave the fields unmutated, and a trace entry claiming a
    // redaction that was never applied is exactly the "control that lies"
    // shape this codebase's own audit discipline exists to prevent. See
    // `recordRedaction` below, the only place that writes the "redact"
    // trace entry, always called right after the matching write-back.
    //
    // A THROWN scan (as opposed to a clean "nothing found") is a different
    // case entirely and is NOT silent: redactToolOutput's caller wraps this
    // in a bare catch so a scan failure degrades to "output left as-is"
    // rather than crashing tool.execute.after (fail-open is deliberate —
    // shipping unredacted output beats losing the outcome/verification
    // record below it), but a scan that throws for a real reason (a
    // mid-session rules-file race, an unexpected output shape) must still
    // leave a trace: `recordRedactionScanFailure` below writes a
    // `redaction-scan-failed` entry, distinct from both a clean allow and a
    // real `redact`, so the failure is discoverable via `keel report`/`keel
    // audit` after the fact instead of vanishing with zero trace.
    const scanForRedaction = async (text: string, sessionID: string | undefined, tool: string | undefined) => {
      if (!text) return null
      const scanInput = toEnforceInput(tool || 'unknown', {}, { sessionID }, level, directory)
      scanInput.tool_output = text
      const result = await pipeline.evaluateOutput(scanInput as any)
      return result.action === 'redact' && result.redacted_output ? result : null
    }
    const recordRedaction = (result: any, sessionID: string | undefined, turn: number, tool: string | undefined) => {
      record({
        session_id: sessionID, turn_number: turn, tool, args: {},
        rule_id: result.rule_id, action: 'redact', message: result.message,
        redacted_rule_ids: result.redacted_rule_ids, hook: 'tool.execute.after', cwd: directory,
      })
    }
    const recordRedactionScanFailure = (error: unknown, sessionID: string | undefined, turn: number, tool: string | undefined) => {
      record({
        session_id: sessionID, turn_number: turn, tool, args: {},
        rule_id: 'redaction-scan-failed', action: 'redaction-scan-failed',
        message: `Output redaction scan threw and was skipped — output shipped unredacted (fail-open): ${error instanceof Error ? error.message : String(error)}`,
        hook: 'tool.execute.after', cwd: directory,
      })
    }

    // Unlikely-to-occur-in-real-content delimiter used only to batch small
    // fields (title, metadata values) into ONE evaluateOutput() call —
    // evaluateOutput()'s checkRuleVersion() re-hashes several rules files
    // from disk on every call (computeRulesHash()), and doing that once per
    // field (title, then every metadata key separately) on this hook's
    // awaited hot path was a real, avoidable cost. Redaction here is plain
    // string replace (never position-based), so joining several field
    // values, scanning once, and splitting the result back apart is exact —
    // not an approximation — as long as the split produces exactly as many
    // parts as fields went in; if it doesn't (the delimiter itself got
    // mangled by truncation or, implausibly, matched by some pattern), the
    // batch is skipped rather than risk assigning a redacted fragment to
    // the wrong field. `output.output` is scanned SEPARATELY, not batched
    // in: it is the one field routinely large enough to hit
    // MAX_OUTPUT_SCAN_CHARS, and batching it with small fields would make
    // an ordinary truncation corrupt the split for every field, not just
    // the large one.
    //
    // The delimiter text is bounded by two literal NUL bytes (\x00), not
    // spaces or any other visible character -- confirmed intentional, not
    // a copy-paste/encoding artifact: NUL bytes essentially never appear
    // in real tool output/title/metadata text, so they collide with
    // genuine content far less often than any printable separator would.
    // Note for future readers: NUL bytes render as blank/invisible in a
    // terminal, a `cat`/`grep` pass, or most line-numbered file viewers --
    // the source around this constant looks like it uses plain spaces
    // unless you inspect the raw bytes (e.g. `od -c`).
    const FIELD_SEP = ' KEEL-FIELD-SEP '

    const redactToolOutput = async (input: any, output: any, turn: number): Promise<void> => {
      if (isDisabled()) return
      if (!output || typeof output !== 'object') return
      if (typeof output.output === 'string' && output.output) {
        const result = await scanForRedaction(output.output, input?.sessionID, input?.tool)
        if (result) {
          output.output = result.redacted_output
          recordRedaction(result, input?.sessionID, turn, input?.tool)
        }
      }
      const smallFields: Array<{ path: 'title' } | { path: 'metadata'; key: string }> = []
      const smallValues: string[] = []
      if (typeof output.title === 'string' && output.title) {
        smallFields.push({ path: 'title' })
        smallValues.push(output.title)
      }
      if (output.metadata && typeof output.metadata === 'object') {
        for (const key of Object.keys(output.metadata)) {
          const value = output.metadata[key]
          if (typeof value === 'string' && value) {
            smallFields.push({ path: 'metadata', key })
            smallValues.push(value)
          }
        }
      }
      if (!smallValues.length) return
      const joined = smallValues.join(FIELD_SEP)
      const result = await scanForRedaction(joined, input?.sessionID, input?.tool)
      if (!result) return
      const parts = result.redacted_output.split(FIELD_SEP)
      // See this block's own header comment: on a mismatch, the batch is
      // skipped WITHOUT recording — nothing was actually applied, so
      // nothing is claimed.
      if (parts.length !== smallFields.length) return
      smallFields.forEach((field, i) => {
        if (field.path === 'title') output.title = parts[i]
        else output.metadata[field.key] = parts[i]
      })
      recordRedaction(result, input?.sessionID, turn, input?.tool)
    }

    const before = async (input: any, output: any) => {
      // Checked BEFORE isDisabled(): if this returned instead, an agent
      // that had already run `keel disable` (or simply has a stale
      // DISABLED sentinel around) would short-circuit-allow right here and
      // pipeline.evaluate() — where the core halt-wins-over-disable check
      // also lives — would never even run, defeating halt's entire "wins
      // even over keel's own controls" guarantee on this host. This is a
      // real deny, not a silent early return like isDisabled()'s branch:
      // it throws the same [Keel]-prefixed error every other deny does, so
      // the tool call is actually blocked, not skipped.
      const halt = isHalted()
      if (halt.halted) {
        const haltArgs = projectAuditArgs(output?.args || {})
        const message = `Keel is HALTED: ${halt.reason}. Run 'keel resume' to clear.`
        record({ session_id: input?.sessionID, turn_number: 0, tool: input?.tool, args: haltArgs, rule_id: 'keel-halted', action: 'deny', message, hook: 'tool.execute.before' })
        try {
          createReceipt('opencode-plugin', input?.tool || 'unknown', haltArgs, 'deny', 'keel-halted', 'keel', input?.sessionID)
        } catch {}
        throw new Error(`[Keel] keel-halted: ${message}`)
      }
      if (isDisabled()) return
      if (sentinelCorrupted) {
        sentinelCorrupted = false
        surfaceWarn('corrupt-kill-switch', 'Invalid keel kill-switch state (DISABLED) detected — enforcement stays ON. Fix or delete ~/.keel/DISABLED to clear this.', input?.sessionID)
      }
      // The dial is user-owned; surface once per session what it actually
      // means at sprint so "fewer checks" is a visible choice, not a silent
      // weakening. NOTE: pipeline.ts's evaluateTiers() computes `deepChecks
      // = depth !== 'fast' || protectFloor(rules)` — protectFloor(rules) is
      // true whenever any `level: protect` content/sequence/flow rule is
      // active, and the shipped default rules always include one
      // (no-exfil-flow, type: flow, level: protect). So with default rules,
      // content/sequence/flow checks are NEVER actually skipped at sprint —
      // only a customized rule set with no protect-floor rule of those
      // types would see them relax. The message below reflects that: it no
      // longer claims those checks are skipped, since that overstates what
      // sprint mode does with the rules most installs actually run.
      if (level === 'sprint') surfaceWarn('dial-sprint', 'Sprint dial is active: deny rules warn only. Protect-floor content/sequence/flow checks (e.g. no-exfil-flow) stay fully active regardless of the dial — only non-floor checks are relaxed.', input?.sessionID)
      await refreshExternalChanges()
      // Deliver any post-edit finding here, on the model-visible channel,
      // before evaluating this call. Non-blocking by design: the agent is
      // told the file it just wrote is broken and can fix it, which is the
      // whole point — interrupting the edit itself would be too late.
      // Only drains THIS session's own queue — see pendingSyntaxFindings'
      // header comment for why a shared, unkeyed queue was wrong.
      const syntaxKey = input?.sessionID || 'unknown'
      const syntaxFindings = pendingSyntaxFindings.get(syntaxKey)
      if (syntaxFindings && syntaxFindings.length) {
        pendingSyntaxFindings.delete(syntaxKey)
        surfaceWarn('post-edit-syntax', syntaxFindings.join(' · '), input?.sessionID, false)
      }
      const args = output?.args || {}
      // v1 M1r-2 — locked product decision: degenerate input fails closed,
      // never a silent allow. opencode types `input` as `any`; a missing/
      // blank `input.tool` means there is no tool identity to evaluate a
      // rule against — structurally the same gap `keel hook <host>` had
      // (hook.ts's ParsedCall.degenerate) for the out-of-process hosts.
      // Falling back to the literal string 'unknown' and evaluating anyway
      // would just match no rule in pipeline.ts (which has no `tool ===
      // 'unknown'` special case) and pass through silently — proven via
      // `record()`'s own trace: nothing downstream could tell the identity
      // was lost. Blocked here, before pipeline.evaluate() ever runs.
      if (typeof input?.tool !== 'string' || input.tool === '') {
        const message = 'No tool identity on this call — keel could not evaluate it, so it was blocked.'
        record({
          session_id: input?.sessionID, turn_number: 0, tool: input?.tool,
          args: projectAuditArgs(args), rule_id: 'fail-closed-degenerate-input',
          action: 'deny', message, hook: 'tool.execute.before',
        })
        try {
          createReceipt('opencode-plugin', 'unknown', projectAuditArgs(args), 'deny', 'fail-closed-degenerate-input', 'keel', input?.sessionID)
        } catch {}
        throw new Error(`[Keel] fail-closed-degenerate-input: ${message}`)
      }
      const enforceInput = toEnforceInput(input.tool, args, input, level, directory)
      const result = await pipeline.evaluate(enforceInput)
      // observed_matches carries EVERY `mode: observe` rule that matched
      // this call (pipeline.ts's evaluate()/violation() — a matched
      // observe rule records and evaluation continues instead of
      // short-circuiting, so more than one can land on one call).
      // observed_action stays as the single-slot legacy view (the first
      // match, or the only one) for every existing trace reader; the
      // promotion pipeline (`keel retrospective`'s promotion section,
      // retrospective.ts's computePromotionReport) reads both.
      record({ session_id: input?.sessionID, turn_number: enforceInput.turn_number, tool: input?.tool, args: projectAuditArgs(args), rule_id: result.rule_id, action: result.action, observed_action: result.observed_action, observed_matches: result.observed_matches, message: result.message, hook: 'tool.execute.before' })
      if (result.action === 'warn' && result.rule_id) surfaceWarn(result.rule_id, result.message, input?.sessionID)
      if (result.action === 'fix') applyFix(args, result)
      if (result.action === 'warn' && result.rule_id && verificationIds.has(result.rule_id)) {
        // Session-scoped, matching turnCounters/surfacedWarnings above: two
        // concurrent sessions in the same project directory must not share
        // one warn-once grace — session A's legitimate first warn must
        // never "use up" session B's own, genuinely-first, occurrence of
        // the same rule and wrongly hard-block session B on what is
        // actually its first offense.
        const key = `${result.rule_id}:${directory}:${input?.sessionID || 'unknown'}`
        if (verificationWarnings.has(key)) {
          throw new Error(`[Keel] ${result.rule_id}: ${result.message}`)
        }
        verificationWarnings.add(key)
      }
      if (result.action === 'deny' || result.action === 'block' || result.action === 'prompt') {
        // Signed-receipt ledger: every gated/blocked action emits an offline-
        // verifiable, hash-chained receipt (`keel verify` reads the same dir).
        try {
          createReceipt('opencode-plugin', input?.tool || 'unknown', projectAuditArgs(args), result.action, result.rule_id || 'unknown', 'keel', input?.sessionID)
        } catch {}
        throw new Error(`[Keel] ${result.rule_id}: ${result.message}`)
      }
      if (result.action === 'redirect') {
        // Course correction: interrupts this call with the directive so the
        // model sees it (the hook cannot inject tool results), but is NOT a
        // deny — complying with the directive clears it and the same action
        // passes next time. No receipt (nothing was blocked).
        const directive = result.redirect
        const hint = directive?.suggested_call ? ` Try: ${directive.suggested_call}` : ''
        throw new Error(`[Keel] REDIRECT ${result.rule_id}: ${result.message}${hint}`)
      }
    }

    return {
      'tool.execute.before': async (input: any, output: any) => {
        try { await before(input, output) } catch (error) {
          if (error instanceof Error && error.message.startsWith('[Keel]')) throw error
          throw new Error(`[Keel] Enforcement failed closed: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      'tool.execute.after': async (input: any, output: any) => {
        try {
          const args = input?.args || {}
          const action = toEnforceInput(input?.tool || 'unknown', args, input, level, directory)
          // Real output redaction runs FIRST — see redactToolOutput's own
          // header comment. Never allowed to fail this hook closed: a
          // redaction-scan error must degrade to "output left as-is," not
          // to a lost verification/outcome record below. The BEHAVIOR here
          // is unchanged (output still ships unredacted on a scan failure,
          // never crashes the hook) — but the failure itself is no longer
          // silent: recordRedactionScanFailure leaves a distinct trace
          // entry so it's discoverable after the fact, instead of shipping
          // a possibly-secret-bearing output with zero record anywhere.
          try { await redactToolOutput(input, output, action.turn_number) } catch (error) {
            recordRedactionScanFailure(error, input?.sessionID, action.turn_number, input?.tool)
          }
          const exit = output?.metadata?.exit === undefined ? null : Number(output?.metadata?.exit)
          if (exit === 0) pipeline.markVerificationSatisfied(action)
          // Outcome telemetry: exit codes feed the stuck-loop detector and
          // make every trace analysis (attempts-until-success, churn)
          // exact. Also record the working directory for per-project work.
          pipeline.recordAttemptOutcome(action, exit)
          record({ session_id: input?.sessionID, turn_number: action.turn_number, tool: input?.tool, args: projectAuditArgs(args), action: 'allow', message: 'Tool completed', hook: 'tool.execute.after', exit, cwd: directory })
          await verifyEdit(input?.tool, args, input?.sessionID, action.turn_number)
          // v1 `type: budget` lane, OpenCode side: reads OpenCode's OWN
          // rollup columns straight off its `session` table (cost already
          // computed in dollars by OpenCode itself — no pricing table
          // needed, see budget/opencode-db.ts's own header). This is the
          // MEASUREMENT half of the same two-phase design the Claude Code
          // side uses (budget-tracker.ts): it only updates the persisted
          // over-budget flag; `tool.execute.before` above (pipeline.
          // evaluate()'s `type: budget` branch) is the ONLY place that
          // ever denies, and it never touches this database. Never allowed
          // to fail this hook closed — a measurement-read failure degrades
          // to `unavailable: true` inside measureOpenCodeSpend itself and
          // is simply recorded as such by recordBudgetSnapshot; this
          // try/catch only guards against an unexpected throw escaping
          // that contract.
          try {
            const spend = await measureOpenCodeSpend(OPENCODE_DB_PATH, input?.sessionID)
            pipeline.recordBudgetSnapshot(action, spend)
          } catch {}
        } catch {}
      },
      /**
       * Claim-to-evidence real reach (v0.4 Phase 1). `tool.execute.before`
       * only ever sees a synthetic `reasoning` field IF a host populates
       * `hookInput.reasoning` (toEnforceInput above) — surveyed and found
       * unpopulated by OpenCode's own PreToolUse-shaped `tool.execute.
       * before` input (see claim.ts's module doc). The channel that DOES
       * carry the agent's own completed output is this hook: confirmed by
       * a live probe (`opencode run` against a scratch repo with a logging
       * plugin, free model `opencode/deepseek-v4-flash-free`, see
       * session/v04/EVIDENCE/phase-1.md) that `output.text` on
       * `experimental.text.complete` is the FULL text of one completed
       * assistant text segment — not a delta, not the model's internal
       * `reasoning`-type part (which never triggers this hook), and it
       * fires strictly after any `tool.execute.after` calls already made
       * in the same turn (so a satisfy command that already ran is
       * reflected in the VerificationTracker's pending state by the time
       * this checks it).
       *
       * Routed through `pipeline.evaluateClaim()`, NOT `pipeline.
       * evaluate()`: the latter would treat one call per assistant
       * utterance as a phantom tool call for flow/sequence/rate state —
       * see evaluateClaim()'s own header comment in pipeline.ts for why
       * that would corrupt the exact trace-derived counters (runaway-
       * budget, stuck-loop) the v0.4 thesis experiment measures in the
       * guarded arm. `evaluateClaim()` only ever touches `type: claim`
       * rules and the same VerificationTracker pending state `type:
       * verification` rules already share.
       */
      'experimental.text.complete': async (input: any, output: any) => {
        try {
          if (isDisabled()) return
          const text = typeof output?.text === 'string' ? output.text : ''
          if (!text) return
          const enforceInput = toEnforceInput('assistant-message', {}, input, level, directory)
          enforceInput.reasoning = text
          const result = await pipeline.evaluateClaim(enforceInput)
          if (result.observed_matches?.length) {
            record({
              session_id: input?.sessionID, turn_number: enforceInput.turn_number,
              tool: 'assistant-message', args: {}, rule_id: result.rule_id, action: result.action,
              observed_action: result.observed_action, observed_matches: result.observed_matches,
              message: result.message, hook: 'experimental.text.complete', cwd: directory,
            })
          }
        } catch {}
      },
      'experimental.chat.system.transform': async (input: any, output: any) => {
        try {
          // One model call = one turn. This is the only turn boundary the
          // plugin can observe, and everything keyed on turn_number
          // (flow correlation, claim-to-tool-call pairing) depends on it.
          advanceTurn(input?.sessionID || lastActiveSession)
          const blocks = requirementSources.map(requirementLines).filter(lines => lines.length)
          if (blocks.length) {
            output.system ||= []
            output.system.push(...blocks.map(lines => `Standing Requirements (mandatory):\n${lines.map(line => `- ${line}`).join('\n')}`))
          }
        } catch {}
      },
      'experimental.session.compacting': async (_input: any, output: any) => {
        try {
          const lines = requirementSources.flatMap(requirementLines)
          if (lines.length) {
            output.context ||= []
            output.context.push(`## Standing Requirements (survive compaction)\n${lines.map(line => `- ${line}`).join('\n')}`)
          }
        } catch {}
      },
    }
  },
}
