import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, rmSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { resolveHome } from '../../home.js'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import type { PipelineConfig } from '../pipeline.js'
import type { ProtectionLevel, RuleContext } from '../../types.js'
import { parseRulesContent } from '../rule-parser.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * M1/A2 — proves the shell-normalization layer (command-normalizer.ts,
 * wired into pipeline.ts's `type: command` matcher via
 * `commandSurfaces()`) closes real bypasses of keel's SHIPPED default
 * rules (the same YAML the OpenCode plugin enforces, loaded here exactly
 * the way threat-model.test.ts does — never a hand-written test-only rule).
 *
 * Every "was already caught" comment below is a MEASURED fact, not an
 * assumption: the shipped patterns are unanchored substring regexes, so
 * several of the red-team's bypass examples already denied on the RAW
 * string today, before this module existed, for reasons that have nothing
 * to do with normalization (e.g. no trailing anchor after the path
 * alternatives `no-destructive-commands` hunts for). The additive
 * constraint means this lane's job is to prove the GENUINELY NEW catches
 * (quoting, variable indirection, compound-command splitting) without
 * breaking anything, not to claim credit for pre-existing behavior.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SENTINEL = join(mkdtempSync(join(tmpdir(), 'keel-shellnorm-sentinel-')), 'DISABLED')

function findPluginSource(start: string): string {
  let dir = start
  for (;;) {
    const candidate = join(dir, 'opencode-plugin', 'src', 'plugin.ts')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error('plugin source not found above ' + start)
    dir = parent
  }
}

function loadDefaultRules(): ReturnType<typeof parseRulesContent> {
  const src = readFileSync(findPluginSource(HERE), 'utf-8')
  const m = src.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  if (!m) throw new Error('DEFAULT_RULES_YAML not found in plugin source')
  const parsed = parseRulesContent(m[1], 'default-rules')
  parsed.rules = parsed.rules.filter(rule => rule.type !== 'time' && rule.type !== 'rate')
  return parsed
}

function makeDefaultsPipeline(level: ProtectionLevel = 'balanced'): EnforcementPipeline {
  const rules = loadDefaultRules()
  rules.config.level = level
  const config: PipelineConfig = {
    level,
    context: 'local' as RuleContext,
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: { global: rules, user: null, project: null, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
    disableFile: SENTINEL,
    overrideStore: { consume: () => false },
  }
  return new EnforcementPipeline(config)
}

function input(tool: string, args: Record<string, unknown>, session: string, level: ProtectionLevel = 'balanced'): Parameters<EnforcementPipeline['evaluate']>[0] {
  return {
    tool,
    args,
    cwd: '/tmp/keel-shellnorm',
    session_id: session,
    turn_number: 1,
    context_tokens: 0,
    level,
    context: 'local' as const,
    agent: 'test-agent',
    subagent_of: null,
  }
}

describe('shell-normalization closes bypasses of the shipped defaults (M1/A2)', () => {
  beforeAll(() => {
    // Mirrors pipeline.ts's own resolveHome()-based fallback.
    const sentinelPath = join(resolveHome(), '.keel', 'DISABLED')
    if (existsSync(sentinelPath)) rmSync(sentinelPath)
  })
  afterAll(() => {
    rmSafe(join(SENTINEL, '..'))
  })

  describe('class 1 — intra-token quoting (GENUINELY NEW catches)', () => {
    const pipeline = makeDefaultsPipeline()
    it('r"m" -rf / denies via no-destructive-commands (raw string alone does NOT contain "rm" — this was allow before the normalizer)', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'r"m" -rf /' }, 'q1'))
      expect(r.action).toBe('deny')
      expect(r.rule_id).toBe('no-destructive-commands')
    })
    it('keel di"s"able denies via keel-control-gate (was allow before the normalizer)', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'keel di"s"able' }, 'q2'))
      expect(r.action).toBe('deny')
      expect(r.rule_id).toBe('keel-control-gate')
    })
    it('git push "--force" denies via no-force-push (was allow before the normalizer — the trailing quote broke the `--force( |=|$)` anchor)', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'git push "--force" origin main' }, 'q3'))
      expect(r.action).toBe('deny')
      expect(r.rule_id).toBe('no-force-push')
    })
  })

  describe('class 2 — variable indirection (GENUINELY NEW catch)', () => {
    const pipeline = makeDefaultsPipeline()
    it('T=/; rm -rf $T denies via no-destructive-commands (raw string never contains "rm -rf /" — was allow before the normalizer)', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'T=/; rm -rf $T' }, 'v1'))
      expect(r.action).toBe('deny')
      expect(r.rule_id).toBe('no-destructive-commands')
    })
  })

  describe('compound-command splitting (already partly caught by unanchored substring matching; normalizer keeps it working and isolates the sub-command)', () => {
    const pipeline = makeDefaultsPipeline()
    it('FOO=1 rm -rf ~ denies (measured: ALREADY denied pre-normalizer — the shipped pattern has no start-of-string anchor, so a leading env-assignment prefix never blocked the match)', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'FOO=1 rm -rf ~' }, 'c1'))
      expect(r.action).toBe('deny')
      expect(r.rule_id).toBe('no-destructive-commands')
    })
    it('x && rm -rf / denies (measured: ALREADY denied pre-normalizer, same reason — an unanchored substring search finds "rm -rf /" wherever it sits in the compound string)', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'x && rm -rf /' }, 'c2'))
      expect(r.action).toBe('deny')
      expect(r.rule_id).toBe('no-destructive-commands')
    })
  })

  describe('interpreter bodies', () => {
    const pipeline = makeDefaultsPipeline()
    it('sh -c "rm -rf /" denies (measured: ALREADY denied pre-normalizer via unanchored substring match — NOT a new catch by itself)', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'sh -c "rm -rf /"' }, 'i1'))
      expect(r.action).toBe('deny')
      expect(r.rule_id).toBe('no-destructive-commands')
    })
    it("sh -c 'r\"m\" -rf /' denies — this IS a new catch: the obfuscated inner payload only becomes visible to the pattern because the normalizer recurses one level into the sh -c body and re-tokenizes it", async () => {
      const r = await pipeline.evaluate(input('Bash', { command: `sh -c 'r"m" -rf /'` }, 'i2'))
      expect(r.action).toBe('deny')
      expect(r.rule_id).toBe('no-destructive-commands')
    })
    it("python3 -c \"import shutil; shutil.rmtree('/')\" denies — M1 ruleset-followups (Task 1): this WAS the honest 'allow' documented here before this lane. The interpreter-body surface A2 exposes was real (proven in command-normalizer.test.ts) but no shipped rule targeted it. A new rule, no-destructive-interpreter-body, now matches destructive python/node calls (shutil.rmtree, os.system/subprocess running rm -rf, os.remove, fs.rmSync/rmdirSync) against a literal root or home target — see DEFAULT_RULES_YAML and tests/rules/no-destructive-interpreter-body/.", async () => {
      const r = await pipeline.evaluate(input('Bash', { command: `python3 -c "import shutil; shutil.rmtree('/')"` }, 'i3'))
      expect(r.action).toBe('deny')
      expect(r.rule_id).toBe('no-destructive-interpreter-body')
    })
  })

  describe('must-not-fire — a benign command must never be caught by the wider normalized surface', () => {
    const pipeline = makeDefaultsPipeline()
    it('rm -rf node_modules stays allow', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'rm -rf node_modules' }, 'b1'))
      expect(r.action).toBe('allow')
    })
    it('git commit -m "force push is bad" stays allow (the substring "force" in a commit message must not trip no-force-push; --signoff included to isolate this from the unrelated must-sign-commits fix rule)', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'git commit --signoff -m "force push is bad"' }, 'b2'))
      expect(r.action).toBe('allow')
    })
    it('echo "rm -rf /" stays allow — M1 ruleset-followups (Task 2, the G2 false positive): this WAS a denied pre-existing false positive documented here before this lane (no-destructive-commands had no anchor requiring "rm" to sit at a real command position, so a quoted echo argument matched the same as a real invocation). Fixed with a negative lookbehind excluding "rm" immediately preceded by a quote character — exactly the A2 quote-preservation signal (a whitespace-bearing quoted argument keeps its quotes verbatim, so "rm" in echo "rm -rf /" is always quote-adjacent on every surface, while a real invocation, including through sudo/compound-splitting/interpreter-body surfaces, never is).', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'echo "rm -rf /"' }, 'b3'))
      expect(r.action).toBe('allow')
    })
    it("echo 'rm -rf /' (single-quoted) stays allow — same fix, other quote style", async () => {
      const r = await pipeline.evaluate(input('Bash', { command: "echo 'rm -rf /'" }, 'b3b'))
      expect(r.action).toBe('allow')
    })
    it('a real rm -rf / behind a sudo prefix still denies — the regression guard for the lookbehind fix: "rm" here is preceded by a space, not a quote, so the fix must not touch it', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'sudo rm -rf /' }, 'b3c'))
      expect(r.action).toBe('deny')
      expect(r.rule_id).toBe('no-destructive-commands')
    })
    it('git commit -m "rm -rf ." stays allow — the discriminating proof for the echo case above: naive unconditional quote-stripping would turn this into a NEW false positive (the bare `.` would then sit at end-of-string and satisfy the `[.]( |$)` anchor). The whitespace-bearing quoted commit message is preserved verbatim instead (--signoff included to isolate this from must-sign-commits).', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'git commit --signoff -m "rm -rf ."' }, 'b4'))
      expect(r.action).toBe('allow')
    })
    it('git commit -m "git push --force" stays allow — same discriminator for no-force-push (--signoff included to isolate this from must-sign-commits)', async () => {
      const r = await pipeline.evaluate(input('Bash', { command: 'git commit --signoff -m "git push --force"' }, 'b5'))
      expect(r.action).toBe('allow')
    })
  })

  describe('protect-floor semantics unaffected: still deny-on-first-hit, no warn-once grace, through the normalized surface', () => {
    it('the new intra-token-quoting catch denies on the FIRST call, not just the second', async () => {
      const pipeline = makeDefaultsPipeline()
      const first = await pipeline.evaluate(input('Bash', { command: 'r"m" -rf /' }, 'p1'))
      expect(first.action).toBe('deny')
    })
  })

  describe('a fix-actioned rule cannot phantom-fix off a normalized-only match', () => {
    // must-sign-commits: match: "git commit(?!.*--signoff)", fix adds
    // --signoff. Quoting "commit" so the RAW string never contains the
    // literal substring "git commit" — only the NORMALIZED surface does.
    // Before gating `fix` on the raw string, this made `matches` true via
    // cmdSurfaces, action:'fix' fired, and fixAction() ran `.replace()`
    // over the RAW string (which the pattern never actually matched) —
    // producing fix_result.original === fix_result.fixed, a receipt
    // claiming a mutation that never happened.
    it('a quoted "git commit" that only matches on the normalized surface does not report a no-op fix', async () => {
      const pipeline = makeDefaultsPipeline()
      const cmd = 'git com"m"it -m "hello world"'
      // Sanity: the normalizer really does turn this into "git commit" —
      // otherwise this test would pass for the wrong reason.
      const commandNormalizer = await import('../command-normalizer.js')
      expect(commandNormalizer.normalizeCommand(cmd).surfaces).toContain('git commit -m "hello world"')

      const r = await pipeline.evaluate(input('Bash', { command: cmd }, 'fixphantom'))
      if (r.action === 'fix') {
        // If some OTHER rule legitimately fixes this for an unrelated
        // reason, the mutation must be real — never original === fixed.
        expect(r.fix_result?.original).not.toBe(r.fix_result?.fixed)
      }
      expect(r.rule_id).not.toBe('must-sign-commits')
    })
  })

  describe('`unless` stays raw-only: widening it would be subtractive, not additive', () => {
    async function evalOnce(yaml: string, command: string) {
      const rules = parseRulesContent(yaml, 'unless-test-rules')
      const pipeline = new EnforcementPipeline({
        level: 'balanced', context: 'local' as RuleContext,
        cache: new ActionCache({ maxSize: 100 }), contentTracker: new ContentTracker(),
        sequenceDetector: new SequenceDetector(), flowTracker: new FlowTracker(),
        ruleHierarchy: { global: null, user: null, project: rules, local: null },
        ruleVersion: 1, allowedFixTransforms: true,
        overrideStore: { consume: () => false },
      })
      return pipeline.evaluate(input('Bash', { command }, 'unless-test'))
    }

    const yaml = `version: 1
rules:
  - id: deny-danger
    type: command
    match: "danger"
    unless:
      - regex: "safe-mode"
    action: deny
    level: protect
    message: "danger, unless safe-mode"
`
    it('an unless exception that only matches a normalized surface does NOT exempt a raw command that denied before', async () => {
      // Quoting "safe-mode" so it only appears on the NORMALIZED surface,
      // never in the raw string — a widened `unless` check would wrongly
      // exempt this and turn a pre-existing deny into an allow.
      const r = await evalOnce(yaml, `danger "safe-mod"e`)
      expect(r.action).toBe('deny')
    })
    it('an unless exception present in the RAW string still exempts, unchanged from before this lane', async () => {
      const r = await evalOnce(yaml, 'danger --safe-mode')
      expect(r.action).toBe('allow')
    })
  })
})
