import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import { loadRuleHierarchy, winningPromotionThreshold, type RuleHierarchy, type ParsedRules } from '../core/enforce/rule-parser.js'
import { isInteractive } from './interactive.js'
import { resolveHome } from '../core/home.js'
import { loadTraceEntries, collectObserveRuleIds, computePromotionReport, type PromotionRow } from './retrospective.js'
import type { RuleMode } from '../core/types.js'

const MODE_ORDER: RuleMode[] = ['observe', 'warn', 'block']

/**
 * The next rung on the promotion ladder: observe → warn → block. A rule
 * already at `block` (or with no `mode` at all, which behaves the same as
 * `block` — see types.ts's RuleMode comment) has nothing left to promote
 * to.
 */
function nextMode(current: RuleMode | undefined): RuleMode | null {
  if (current === 'observe') return 'warn'
  if (current === 'warn') return 'block'
  return null
}

export interface WriteRuleModeResult {
  changed: boolean
  previousMode: RuleMode | undefined
  newMode: RuleMode
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Surgical, comment-preserving edit of a single rule's `mode:` field
 * inside a rules.yaml — mirrors level.ts's writeRulesLevel (a line-based
 * patch rather than a full YAML re-serialize) so every OTHER hand-written
 * comment, blank line, and field ordering in the file survives untouched.
 * `keel level` patches a top-level scalar; this patches one field inside
 * one list item, so it first locates that item's block (from its `- id:
 * <ruleId>` line to the next same-or-lower-indent line) and only edits
 * within it.
 *
 * Returns null if the rule id's `- id:` line cannot be found in this file
 * (the caller already matched the id against a ParsedRules.rules array
 * built from the SAME file, so this should not happen in practice — it is
 * a defensive check against the two falling out of sync, e.g. a duplicate
 * id or unusual YAML shape the line-scanner doesn't handle).
 */
export function writeRuleMode(filePath: string, ruleId: string, newMode: RuleMode): WriteRuleModeResult | null {
  const source = readFileSync(filePath, 'utf-8')
  const lines = source.split('\n')
  const idPattern = new RegExp(`^(\\s*)-\\s*id:\\s*["']?${escapeRegExp(ruleId)}["']?\\s*$`)

  let itemLine = -1
  let itemIndent = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(idPattern)
    if (m) {
      itemLine = i
      itemIndent = m[1].length
      break
    }
  }
  if (itemLine < 0) return null

  // The rule's block runs from its `- id:` line to the next line at the
  // same or lower indentation (the next list item, or a dedent out of the
  // `rules:` list entirely) — everything more-indented than that belongs
  // to this rule.
  let blockEnd = lines.length
  for (let j = itemLine + 1; j < lines.length; j++) {
    const line = lines[j]
    if (!line.trim()) continue
    const indent = line.match(/^(\s*)/)![1].length
    if (indent <= itemIndent) {
      blockEnd = j
      break
    }
  }

  // Fields on a `- id: x` item line up two columns in from the item's own
  // indentation (`- id: x` → `  type: y` in DEFAULT_RULES_YAML's own
  // convention — the dash-plus-space consumes exactly that width).
  const fieldIndent = itemIndent + 2
  const modePattern = /^\s*mode:\s*(\S+)\s*$/
  let modeLine = -1
  let previousMode: RuleMode | undefined
  for (let j = itemLine; j < blockEnd; j++) {
    const m = lines[j].match(modePattern)
    if (m) {
      modeLine = j
      previousMode = m[1] as RuleMode
      break
    }
  }

  if (modeLine >= 0) {
    lines[modeLine] = `${' '.repeat(fieldIndent)}mode: ${newMode}`
  } else {
    lines.splice(itemLine + 1, 0, `${' '.repeat(fieldIndent)}mode: ${newMode}`)
  }
  writeFileSync(filePath, lines.join('\n'))
  return { changed: true, previousMode, newMode }
}

/** Which parsed rules.yaml (if any) declares this rule id — project over local over global over user, most-specific first. */
function findRuleSource(hierarchy: RuleHierarchy, ruleId: string): { source: ParsedRules; mode: RuleMode | undefined } | null {
  for (const source of [hierarchy.project, hierarchy.local, hierarchy.global, hierarchy.user]) {
    if (!source) continue
    const rule = source.rules.find((r) => r.id === ruleId)
    if (rule) return { source, mode: rule.mode }
  }
  return null
}

/**
 * This rule's measured promotion evidence, computed the SAME way `keel
 * retrospective`'s promotion section and `keel report` already compute it
 * (computePromotionReport/collectObserveRuleIds/winningPromotionThreshold,
 * all imported from retrospective.ts and rule-parser.ts, not re-implemented
 * here) — so `keel promote`'s verdict can never silently disagree with what
 * those two commands just told the human about the same rule.
 *
 * Only ever meaningful for a rule currently in `mode: observe`: that is the
 * ONLY rung with a measured "would-block" signal at all. `mode: warn` is
 * real enforcement (pipeline.ts's effectiveAction() special-cases only
 * `observe`), so a warn-mode rule never populates observed_action/
 * observed_matches on its trace entries and there is nothing here to
 * measure for a warn → block promotion — see promoteCommand's own handling
 * of that case.
 *
 * Reads KEEL_TRACES_DIR fresh on every call rather than caching it at
 * module scope — a module-level const would freeze whatever the env var
 * was at first import, which is exactly the bug retrospective.ts's and
 * report.ts's identical comments both warn against.
 */
function evidenceForObserveRule(ruleId: string, hierarchy: RuleHierarchy, cwd: string): PromotionRow | null {
  const auditDir = process.env.KEEL_TRACES_DIR || join(resolveHome(), '.keel', 'traces')
  const entries = loadTraceEntries(auditDir)
  const rules = collectObserveRuleIds(hierarchy)
  const threshold = winningPromotionThreshold(hierarchy)
  const rows = computePromotionReport(entries, rules, threshold, cwd)
  return rows.find((r) => r.rule_id === ruleId) || null
}

/**
 * `keel promote <rule-id> [--to warn|block] [--force]` — advance a `mode:
 * observe` rule one rung up the ladder (observe → warn → block), or jump
 * straight to an explicit `--to` target.
 *
 * User-owned by construction, the same way `keel level` and `keel rules
 * harness --append` are: this edits the rules.yaml the rule lives in, so
 * it is TTY-gated exactly like those (see rules.ts's identical guard) and
 * is on the `keel-control-gate` deny list — an agent cannot run this
 * itself, only the human deciding a rule has burned in long enough.
 *
 * Evidence-gated when promoting FROM `mode: observe` (whatever the
 * target): `promotion_fp_threshold` existed in KeelConfig since the start
 * but was never actually read anywhere — this is that wiring. Before
 * writing the mode change, the rule's measured would-block rate is looked
 * up via the exact same computePromotionReport() pipeline `keel
 * retrospective`'s promotion section already surfaces, and the promotion
 * is refused (exit 1, file untouched) unless that pipeline says
 * `eligible`. `--force` is the deliberate human override — it always wins,
 * but prints a distinct, honest warning instead of silently proceeding, so
 * a forced promotion is never mistaken for an earned one. Promoting FROM
 * `warn` (to `block`) has no such gate: `mode: warn` is real enforcement,
 * not shadow-recording, so there is no measured would-block stream for it
 * to check — see evidenceForObserveRule's own comment.
 *
 * Idempotent: promoting a rule to the mode it is already at is a no-op,
 * not an error, so a re-run (or a flaky script) never corrupts the file.
 * Never auto-promotes anything — this command only runs when a human
 * types it.
 */
export async function promoteCommand(ruleId: string | undefined, options: { to?: string; cwd?: string; force?: boolean } = {}) {
  if (!isInteractive() && process.env.KEEL_ALLOW_NON_TTY !== '1') {
    console.error(chalk.red('\n  `keel promote` edits your rules.yaml, so it must be run from your own terminal.'))
    console.error(chalk.dim('  Run `keel retrospective` to see promotion recommendations instead.\n'))
    process.exitCode = 1
    return
  }
  if (!ruleId) {
    console.log(chalk.red('  Usage: keel promote <rule-id> [--to warn|block]'))
    process.exitCode = 1
    return
  }
  if (options.to !== undefined && !(MODE_ORDER as string[]).includes(options.to)) {
    console.log(chalk.red(`  Invalid --to "${options.to}". Use warn or block (mode: observe is the start of the ladder, never a promotion target).`))
    process.exitCode = 1
    return
  }

  const cwd = options.cwd || process.cwd()
  const hierarchy = loadRuleHierarchy(cwd)
  const found = findRuleSource(hierarchy, ruleId)
  if (!found) {
    console.log(chalk.red(`  Rule "${ruleId}" not found in any rules.yaml (project, local, global, user).`))
    console.log(chalk.dim('  Run `keel validate` or `keel status` to see the active rules.'))
    process.exitCode = 1
    return
  }
  const { source, mode: currentMode } = found

  const target = (options.to as RuleMode | undefined) || nextMode(currentMode)
  if (!target) {
    console.log(chalk.yellow(`  "${ruleId}" is already at full enforcement (mode: ${currentMode || 'block'}) — nothing to promote.`))
    return
  }
  if (currentMode === target) {
    console.log(chalk.dim(`  "${ruleId}" is already mode: ${target}. No change.`))
    return
  }

  if (currentMode === 'observe') {
    const row = evidenceForObserveRule(ruleId, hierarchy, cwd)
    const eligible = row?.recommendation === 'eligible'
    if (!eligible) {
      if (!options.force) {
        const insufficientData = !row || row.recommendation === 'insufficient_data'
        console.log(chalk.red(`\n  "${ruleId}" is not yet eligible for promotion.`))
        console.log(insufficientData
          ? chalk.dim('  Not enough recorded hits yet — too little traffic to trust a would-block rate this small.')
          : chalk.dim('  Its measured would-block (false-positive) rate has not cleared promotion_fp_threshold — it may still be firing on legitimate work.'))
        if (row) console.log(chalk.dim(`  ${row.detail}`))
        console.log(chalk.dim('  Run `keel retrospective` for the full picture, or re-run with --force to promote anyway.\n'))
        process.exitCode = 1
        return
      }
      console.log(chalk.yellow(`  Forcing promotion without evidence — "${ruleId}" may not be ready.`))
    }
  } else if (currentMode === 'warn') {
    console.log(chalk.dim(`  Note: keel has no measured evidence for warn → block (only mode: observe rules are shadow-recorded) — watch \`keel report\` before relying on this.`))
  }

  const result = writeRuleMode(source.sourcePath, ruleId, target)
  if (!result) {
    console.log(chalk.red(`  Could not locate "${ruleId}"'s block in ${source.sourcePath} — no change made.`))
    process.exitCode = 1
    return
  }

  console.log(chalk.green(`\n  ✓ ${ruleId}: mode ${result.previousMode || '(unset — full enforcement)'} → ${result.newMode}`))
  console.log(chalk.dim(`  ${source.sourcePath}`))
  if (result.newMode === 'block') {
    console.log(chalk.yellow(`\n  "${ruleId}" now enforces at its declared action — it can interrupt tool calls.`))
  } else {
    console.log(chalk.dim(`\n  "${ruleId}" now warns instead of just recording. Keep watching \`keel retrospective\` before promoting to block.`))
  }
  console.log()
}
