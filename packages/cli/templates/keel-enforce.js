// keel-enforce — Keel enforcement plugin for OpenCode
//
// CANONICAL SOURCE. This single file is used by:
//   1. `keel install --opencode`  — copied to ~/.opencode/plugins/keel-enforce.js
//   2. `keel install --project`   — copied to <project>/.opencode/plugins/keel-enforce.js
//   3. @get-keel/opencode-plugin npm  — built to dist/index.js verbatim
//
// Hooks (SPEC.md §6):
//   tool.execute.before                — deny/warn/fix every tool call (involuntary)
//   tool.execute.after                 — record successful verification commands
//   experimental.chat.system.transform — inject standing requirements each turn (voluntary)
//   experimental.session.compacting    — embed requirements in compaction context (backup)
//
// Format: V1 `{ id, server }` — REQUIRED for file plugins (OpenCode throws
// "Path plugin must export id" otherwise). The `export const` style shown in
// OpenCode docs is the legacy format.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const KEEL_DIR = path.join(os.homedir(), '.keel')
const RULES_PATH = path.join(KEEL_DIR, 'rules.yaml')
const REQUIREMENTS_PATH = path.join(KEEL_DIR, 'requirements.md')
const STATE_PATH = path.join(KEEL_DIR, 'state', 'deny-first-time.json')
const DISABLED_PATH = path.join(KEEL_DIR, 'DISABLED')
const CONFIG_PATH = path.join(KEEL_DIR, 'config.json')
const TRACES_DIR = path.join(KEEL_DIR, 'traces')
const VERIFICATION_STATE_PATH = path.join(KEEL_DIR, 'state', 'verification.json')
const DENY_TTL_MS = 24 * 60 * 60 * 1000

// Keep in sync with DEFAULT_RULES_YAML in packages/cli/src/commands/install.ts.
const DEFAULT_RULES_YAML = `# Keel rules — enforced OUTSIDE agent context (via OpenCode plugin)
# These rules cannot be forgotten, overridden, or degraded by context rot.
# Layer 3 enforcement (semantic) — runs before every tool dispatch.
version: 1
level: balanced
rules:
  - id: product-name-is-keel
    type: command
    match: "(sed|replaceAll|rename).*(keel|product).*(ai-enforce)"
    action: deny
    level: sprint
    priority: 100
    message: "Product name is 'keel'. Never change it back to ai-enforce."

  - id: source-change-requires-test
    type: verification
    trigger:
      tools: [WriteFile, edit]
      path: "src/"
      pattern: "src/"
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
    message: "Source changes require a successful test run before commit or push."

  - id: verify-format-before-decision
    type: command
    match: "(default|choose).*(format|config|rule)"
    action: warn
    unless_reasoning: "user.*(said|asked|want|use|prefer)|verify|check|ask"
    message: "You are choosing a format without verifying the user. Ask what they use before deciding."

  - id: no-force-push
    type: command
    match: "git push --force(?!-with-lease)"
    action: deny
    level: sprint
    message: "Use --force-with-lease instead of --force."

  - id: no-destructive-commands
    type: command
    match: "rm -rf /|rm -rf ~"
    action: deny
    level: sprint
    message: "Destructive commands are blocked."

  - id: must-sign-commits
    type: command
    match: "git commit"
    action: fix
    fix:
      - pattern: "git commit"
        replace: "git commit --signoff"
    message: "Auto-adding --signoff to commits."

  - id: re-inject-at-thresholds
    type: context
    message: "Re-inject standing requirements at 8K/16K/32K token thresholds to combat context drift."

  - id: verify-before-irreversible
    type: command
    match: "gh repo delete|gh repo transfer|npm unpublish|git push --force(?!-with-lease)|rm -rf (?!.*node_modules)"
    action: warn
    message: "Irreversible action — verify inbound references (npm metadata, badges, forks, links) and state what was checked vs assumed before proceeding."
`

// ── config (permissive by default; ~/.keel/config.json optional) ──
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      return { record_all: cfg.record_all === true }
    }
  } catch {}
  return { record_all: false }
}

// ── kill switch (matches `keel disable` / `keel enable`) ──
function isDisabled() {
  try {
    if (!fs.existsSync(DISABLED_PATH)) return false
    const state = JSON.parse(fs.readFileSync(DISABLED_PATH, 'utf-8'))
    if (state.expires_at && new Date(state.expires_at) < new Date()) {
      fs.rmSync(DISABLED_PATH, { force: true })
      return false
    }
    return true
  } catch {
    return false
  }
}

// ── rule loading ──
function loadRules(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf-8')
    const rules = []
    const blocks = text.split(/\n\s+-\s+id:\s*/)
    if (blocks.length >= 2) {
      for (let i = 1; i < blocks.length; i++) {
        const b = blocks[i]
        const id = b.split('\n')[0]?.trim()
        const type = b.match(/type:\s*(\S+)/)?.[1]
        const match = b.match(/match:\s*["']?([^"'\n]+)["']?/)?.[1]
        const action = b.match(/action:\s*(\S+)/)?.[1]
        const msg = b.match(/message:\s*["']?([^"'\n]+)["']?/)?.[1]
        if (!id || !type) continue

        if (type === 'command' || type === 'content') {
          if (!match) continue
          const fix = []
          const fixRe = /pattern:\s*["']([^"']+)["']\s*\n\s*replace:\s*["']([^"']+)["']/g
          let hit
          while ((hit = fixRe.exec(b)) !== null) {
            fix.push({ pattern: hit[1], replace: hit[2] })
          }
          rules.push({
            id,
            type,
            match,
            action: action || 'deny',
            message: msg || '',
            ...(fix.length ? { fix } : {}),
          })
        } else if (type === 'sequence') {
          const steps = []
          const stepRe = /-\s+tool:\s*(\S+)(?:\n\s+path:\s*["']?([^"'\n]+)["']?)?(?:\n\s+pattern:\s*["']([^"'\n]+)["']?)?/g
          let stepHit
          while ((stepHit = stepRe.exec(b)) !== null) {
            steps.push({
              tool: stepHit[1],
              ...(stepHit[2] ? { path: stepHit[2] } : {}),
              ...(stepHit[3] ? { pattern: stepHit[3] } : {}),
            })
          }
          if (steps.length < 2) continue
          rules.push({
            id,
            type,
            steps,
            sequence_window_seconds: Number(b.match(/sequence_window_seconds:\s*(\d+)/)?.[1] || 60),
            action: action || 'deny',
            message: msg || '',
          })
        } else if (type === 'verification') {
          const trigger = parseMatcher(b, 'trigger')
          const satisfy = parseMatcher(b, 'satisfy')
          if (!trigger || !satisfy) continue
          const boundaries = {}
          const boundaryRe = /(?:^|\n)\s{2,}(commit|push):\s*\n\s+pattern:\s*["']([^"'\n]+)["'](?:\s*\n\s+action:\s*(\S+))?/g
          let boundary
          while ((boundary = boundaryRe.exec(b)) !== null) {
            boundaries[boundary[1]] = { pattern: boundary[2], action: boundary[3] || 'deny' }
          }
          rules.push({
            id,
            type,
            trigger,
            satisfy,
            boundaries,
            verification_window_seconds: Number(b.match(/verification_window_seconds:\s*(\d+)/)?.[1] || 300),
            action: action || 'deny',
            message: msg || '',
          })
        }
      }
    }
    return rules
  } catch {
    return []
  }
}

// ── sequence detection (mirrors core/src/enforce/sequencer.ts) ──
function matchesStep(step, tool, args) {
  if (String(step.tool).toLowerCase() !== String(tool).toLowerCase()) return false
  if (step.path) {
    const argPath = String(args.path || args.filePath || args.file || args.dest || '')
    if (!argPath.includes(step.path)) return false
  }
  if (step.pattern) {
    const argStr = JSON.stringify(args)
    try {
      if (!new RegExp(step.pattern, 'i').test(argStr)) return false
    } catch {
      return false
    }
  }
  return true
}

// Returns a violation message when the current action completes a forbidden
// sequence within the rule's window, otherwise null.
function checkSequence(rule, tool, args, history) {
  if (!rule.steps || rule.steps.length < 2) return null
  const windowMs = (rule.sequence_window_seconds || 60) * 1000
  const cutoff = Date.now() - windowMs
  const recent = history.filter(r => r.timestamp >= cutoff)

  const lastStep = rule.steps[rule.steps.length - 1]
  if (!matchesStep(lastStep, tool, args)) return null

  let idx = recent.length - 1
  for (let s = rule.steps.length - 2; s >= 0; s--) {
    let found = false
    while (idx >= 0) {
      const rec = recent[idx]
      idx--
      if (matchesStep(rule.steps[s], rec.tool, rec.args)) {
        found = true
        break
      }
    }
    if (!found) return null
  }
  return `Sequence detected: ${rule.steps.map(s => s.tool).join(' → ')} (rule: ${rule.id})`
}

function parseMatcher(block, name) {
  const marker = new RegExp(`(?:^|\\n)\\s*${name}:`)
  const match = marker.exec(block)
  if (!match) return null
  const section = block.slice(match.index + match[0].length)
  const next = section.search(/\n\s{2,}(?:trigger|satisfy|boundaries|action|message|priority|verification_window_seconds):/)
  const text = next >= 0 ? section.slice(0, next) : section
  const toolsMatch = text.match(/tools:\s*\[([^\]]+)\]/)
  const tools = toolsMatch?.[1].split(',').map(value => value.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  const tool = text.match(/(?:^|\n)\s*tool:\s*([^\s\n]+)/)?.[1]
  const pathValue = text.match(/(?:^|\n)\s*path:\s*["']?([^"'\n]+)["']?/)?.[1]
  const pattern = text.match(/(?:^|\n)\s*pattern:\s*["']([^"']+)["']/)?.[1]
  if (!tools?.length && !tool && !pathValue && !pattern) return null
  return { ...(tools?.length ? { tools } : {}), ...(tool ? { tool } : {}), ...(pathValue ? { path: pathValue } : {}), ...(pattern ? { pattern } : {}) }
}

function matchesVerification(matcher, tool, args) {
  if (!matcher) return false
  const tools = matcher.tools || (matcher.tool ? [matcher.tool] : [])
  if (tools.length && !tools.some(t => t.toLowerCase() === String(tool).toLowerCase())) return false
  if (matcher.path) {
    const value = String(args.path || args.filePath || args.file || args.dest || '')
    if (!value.includes(matcher.path)) return false
  }
  if (matcher.pattern && !testMatch(matcher.pattern, JSON.stringify(args))) return false
  return true
}

function worktreeFingerprint(directory, sourcePath) {
  if (!sourcePath) return null
  try {
    const diff = spawnSync('git', ['-C', directory, 'diff', '--binary', 'HEAD', '--', sourcePath], { encoding: 'utf-8' })
    if (diff.status !== 0) return null
    const untracked = spawnSync('git', ['-C', directory, 'ls-files', '--others', '--exclude-standard', '--', sourcePath], { encoding: 'utf-8' })
    if (untracked.status !== 0) return null
    let content = `${diff.stdout}\n${untracked.stdout}`
    for (const relative of untracked.stdout.split('\n').filter(Boolean)) {
      try { content += `\n${relative}\n${fs.readFileSync(path.join(directory, relative), 'utf-8')}` } catch {}
    }
    return crypto.createHash('sha256').update(content).digest('hex')
  } catch {
    return null
  }
}

// ── requirements loading (returns bullet-ready lines, headers stripped) ──
function loadRequirementLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return []
    return fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .map(l => l.replace(/^#+\s*/, '').trim())
      .filter(l => l && !l.startsWith('[') && !l.startsWith('<!--'))
  } catch {
    return []
  }
}

// ── state (warn-then-deny escalation, survives restarts) ──
function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'))
  } catch {}
  return {}
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
    const tmp = STATE_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state))
    fs.renameSync(tmp, STATE_PATH)
  } catch {}
}

function loadVerificationState() {
  try {
    if (fs.existsSync(VERIFICATION_STATE_PATH)) return JSON.parse(fs.readFileSync(VERIFICATION_STATE_PATH, 'utf-8'))
  } catch {}
  return {}
}

function saveVerificationState(state) {
  try {
    fs.mkdirSync(path.dirname(VERIFICATION_STATE_PATH), { recursive: true })
    const tmp = VERIFICATION_STATE_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state))
    fs.renameSync(tmp, VERIFICATION_STATE_PATH)
  } catch {}
}

// ── audit (JSONL, compatible with keel suggest / lessons / watch) ──
function record(entry) {
  try {
    fs.mkdirSync(TRACES_DIR, { recursive: true })
    const now = new Date()
    const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    fs.appendFileSync(
      path.join(TRACES_DIR, `${d}.jsonl`),
      JSON.stringify({
        t: Date.now(),
        timestamp: now.toISOString(),
        session_id: entry.session_id || 'unknown',
        tool: entry.tool,
        args: entry.args || {},
        rule_id: entry.rule_id || null,
        rule_name: entry.rule_name || '',
        action: entry.action,
        message: entry.message || '',
        agent: entry.agent || 'opencode-plugin',
        hook: entry.hook || null,
      }) + '\n'
    )
  } catch {}
}

function testMatch(pattern, text) {
  try {
    return new RegExp(pattern, 'i').test(text)
  } catch {
    return false
  }
}

function applyFix(rule, args) {
  if (!rule.fix || !rule.fix.length) return false
  const command = typeof args?.command === 'string' ? args.command : null
  if (!command) return false
  let next = command
  for (const f of rule.fix) {
    next = next.split(f.pattern).join(f.replace)
  }
  if (next !== command) {
    args.command = next
    return true
  }
  return false
}

export default {
  id: 'keel-enforce',

  server: async (input) => {
    const projectKeelDir = input?.directory ? path.join(input.directory, '.keel') : null
    const config = loadConfig()

    // Self-bootstrap: zero-config users get working defaults.
    if (!fs.existsSync(RULES_PATH)) {
      try {
        fs.mkdirSync(KEEL_DIR, { recursive: true })
        fs.writeFileSync(RULES_PATH, DEFAULT_RULES_YAML, 'utf-8')
      } catch {}
    }

    // Project rules override global rules for the same rule id.
    let rules = loadRules(RULES_PATH)
    const projectRulesPath = projectKeelDir ? path.join(projectKeelDir, 'rules.yaml') : null
    if (projectRulesPath && fs.existsSync(projectRulesPath)) {
      const projectRules = loadRules(projectRulesPath)
      if (projectRules.length) {
        rules = [...projectRules, ...rules.filter(g => !projectRules.some(p => p.id === g.id))]
      }
    }

    let denyState = loadState()

    // In-process action history for sequence rules (sliding window).
    const history = []
    const maxSeqWindowMs = Math.max(300, ...rules.filter(r => r.type === 'sequence').map(r => (r.sequence_window_seconds || 60) * 1000))
    const verificationState = loadVerificationState()
    const verificationScope = input?.directory || process.cwd()
    const verificationKey = rule => `${rule.id}:${verificationScope}`
    const verificationBaseline = new Map()
    for (const rule of rules) {
      if (rule.type === 'verification') {
        verificationBaseline.set(verificationKey(rule), worktreeFingerprint(verificationScope, rule.trigger?.path))
      }
    }

    const refreshVerificationChanges = () => {
      for (const rule of rules) {
        if (rule.type !== 'verification' || !rule.trigger?.path) continue
        const key = verificationKey(rule)
        const current = worktreeFingerprint(verificationScope, rule.trigger.path)
        const baseline = verificationBaseline.get(key)
        if (current && baseline && current !== baseline && !verificationState[key]) {
          verificationState[key] = Date.now()
          saveVerificationState(verificationState)
        }
      }
    }

    record({ tool: 'keel-init', action: 'allow', message: `Keel server started (${rules.length} rules)`, hook: 'init' })

    const requirementSources = [
      REQUIREMENTS_PATH,
      ...(projectKeelDir && projectKeelDir !== KEEL_DIR ? [path.join(projectKeelDir, 'requirements.md')] : []),
    ]

    return {
      'tool.execute.before': async (input, output) => {
        try {
          if (isDisabled()) return
          const tool = input?.tool || 'unknown'
          const args = output?.args || {}
          const str = JSON.stringify(args)

          // Record the action for sequence detection, then prune stale entries.
          history.push({ tool, args, timestamp: Date.now() })
          const seqCutoff = Date.now() - maxSeqWindowMs
          while (history.length && history[0].timestamp < seqCutoff) history.shift()
          refreshVerificationChanges()

          // Concrete completion boundaries are checked before ordinary command rules.
          const boundaryRule = rules.find(r => {
            if (r.type !== 'verification' || !verificationState[verificationKey(r)]) return false
            const pendingAt = verificationState[verificationKey(r)]
            if (Date.now() - pendingAt > (r.verification_window_seconds || 300) * 1000) {
              delete verificationState[verificationKey(r)]
              saveVerificationState(verificationState)
              return false
            }
            return Object.values(r.boundaries || {}).some(boundary => testMatch(boundary.pattern, str))
          })
          if (boundaryRule) {
            const boundary = Object.values(boundaryRule.boundaries || {}).find(b => testMatch(b.pattern, str))
            const entry = { session_id: input?.sessionID, tool, args, rule_id: boundaryRule.id, rule_name: boundaryRule.id, agent: 'opencode-plugin' }
            const boundaryStateKey = `${boundaryRule.id}:${verificationScope}`
            const lastBoundary = denyState[boundaryStateKey]
            if (boundary?.action === 'warn' && (!lastBoundary || Date.now() - lastBoundary > DENY_TTL_MS)) {
              denyState[boundaryStateKey] = Date.now()
              saveState(denyState)
              record({ ...entry, action: 'warn', message: `First violation of "${boundaryRule.id}" — warning only. Next time will be blocked.`, hook: 'tool.execute.before' })
              return
            }
            record({ ...entry, action: 'deny', message: boundaryRule.message, hook: 'tool.execute.before' })
            throw new Error(`[Keel] ${boundaryRule.id}: ${boundaryRule.message}`)
          }

          const rule = rules.find(r => (r.type === 'command' || r.type === 'content') && testMatch(r.match, str))

          if (rule) {
            const entry = {
              session_id: input?.sessionID,
              tool,
              args,
              rule_id: rule.id,
              rule_name: rule.id,
              agent: 'opencode-plugin',
            }

            if (rule.action === 'fix') {
              const applied = applyFix(rule, args)
              record({ ...entry, action: 'fix', message: applied ? `${rule.message} (fixed)` : rule.message, hook: 'tool.execute.before' })
              return
            }

            if (rule.action === 'warn') {
              record({ ...entry, action: 'warn', message: rule.message, hook: 'tool.execute.before' })
              return
            }

            // deny / block — first violation warns, repeat denies.
            const last = denyState[rule.id]
            if (!last || Date.now() - last > DENY_TTL_MS) {
              denyState[rule.id] = Date.now()
              saveState(denyState)
              record({ ...entry, action: 'warn', message: `First violation of "${rule.id}" — warning only. Next time will be blocked.`, hook: 'tool.execute.before' })
              return
            }
            record({ ...entry, action: 'deny', message: rule.message, hook: 'tool.execute.before' })
            throw new Error(`[Keel] ${rule.id}: ${rule.message}`)
          }

          // Sequence rules — did this call complete a forbidden sequence?
          const seqRule = rules.find(r => r.type === 'sequence' && checkSequence(r, tool, args, history))
          if (seqRule) {
            const entry = {
              session_id: input?.sessionID,
              tool,
              args,
              rule_id: seqRule.id,
              rule_name: seqRule.id,
              agent: 'opencode-plugin',
            }
            if (seqRule.action === 'warn') {
              record({ ...entry, action: 'warn', message: seqRule.message, hook: 'tool.execute.before' })
              return
            }
            // deny / block — first violation warns, repeat denies.
            const last = denyState[seqRule.id]
            if (!last || Date.now() - last > DENY_TTL_MS) {
              denyState[seqRule.id] = Date.now()
              saveState(denyState)
              record({ ...entry, action: 'warn', message: `First violation of "${seqRule.id}" — warning only. Next time will be blocked.`, hook: 'tool.execute.before' })
              return
            }
            record({ ...entry, action: 'deny', message: seqRule.message, hook: 'tool.execute.before' })
            throw new Error(`[Keel] ${seqRule.id}: ${seqRule.message}`)
          }

          for (const rule of rules) {
            if (rule.type === 'verification' && matchesVerification(rule.trigger, tool, args)) {
              verificationState[verificationKey(rule)] = Date.now()
              saveVerificationState(verificationState)
            }
          }

          if (config.record_all) {
            record({ session_id: input?.sessionID, tool, args, rule_id: null, action: 'allow', message: 'No matching rule', hook: 'tool.execute.before' })
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('[Keel]')) throw err
          // Plugin faults must never break OpenCode.
        }
      },

      'tool.execute.after': async (input, output) => {
        try {
          refreshVerificationChanges()
          const exitCode = Number(output?.metadata?.exit)
          for (const rule of rules) {
            if (rule.type !== 'verification') continue
            const key = verificationKey(rule)
            if (matchesVerification(rule.satisfy, input?.tool, input?.args || {}) && exitCode === 0) {
              delete verificationState[key]
              saveVerificationState(verificationState)
              verificationBaseline.set(key, worktreeFingerprint(verificationScope, rule.trigger?.path))
              record({ session_id: input?.sessionID, tool: input?.tool, args: input?.args || {}, rule_id: rule.id, action: 'allow', message: 'Verification obligation satisfied', hook: 'tool.execute.after' })
            }
          }
        } catch {}
      },

      'experimental.chat.system.transform': async (input, output) => {
        try {
          const blocks = []
          for (const src of requirementSources) {
            const lines = loadRequirementLines(src)
            if (lines.length) {
              blocks.push(`Standing Requirements (mandatory):\n${lines.map(l => `- ${l}`).join('\n')}`)
            }
          }
          if (blocks.length) {
            if (!output.system) output.system = []
            output.system.push(...blocks)
            record({ session_id: input?.sessionID, tool: 'chat', rule_id: null, action: 'allow', message: `Injected ${blocks.length} requirement block(s) into system prompt`, hook: 'system.transform' })
          }
        } catch {}
      },

      'experimental.session.compacting': async (input, output) => {
        try {
          const lines = []
          for (const src of requirementSources) {
            lines.push(...loadRequirementLines(src))
          }
          if (lines.length) {
            if (!output.context) output.context = []
            output.context.push(`## Standing Requirements (survive compaction)\n${lines.map(l => `- ${l}`).join('\n')}`)
            record({ session_id: input?.sessionID, tool: 'compaction', rule_id: null, action: 'allow', message: `Embedded ${lines.length} requirement line(s) in compaction context`, hook: 'session.compacting' })
          }
        } catch {}
      },
    }
  },
}
