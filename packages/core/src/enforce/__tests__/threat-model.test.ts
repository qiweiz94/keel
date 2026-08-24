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
 * Agentic threat model — a misbehaving coding agent tries the common failure
 * modes (destructive commands, history rewrites, unverified claims, secret
 * leaks, identity renaming) against keel's SHIPPED default rules (the same
 * YAML the OpenCode plugin enforces). Each case asserts keel's exact verdict.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))

// Kill-switch sentinel for the test pipelines lives in a private tmp dir so
// this suite never touches (or is touched by) the developer's real ~/.keel.
const SENTINEL = join(mkdtempSync(join(tmpdir(), 'keel-threat-sentinel-')), 'DISABLED')
// Same isolation for the halt sentinel — a live `~/.keel/HALTED` on the
// developer's machine must not make every pipeline in this file deny.
const HALT_SENTINEL = join(mkdtempSync(join(tmpdir(), 'keel-threat-halt-')), 'HALTED')

// The CLI vendors core sources (packages/cli/src/core) at build time, so the
// plugin source must be located from the nearest repo root upward.
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
  const yaml = m[1]
  const parsed = parseRulesContent(yaml, 'default-rules')
  // Determinism: `time` and `rate` rules depend on the wall clock and call
  // volume, so they are excluded from these fixtures (they are still tested
  // directly in pipeline.test.ts and shipped in the defaults).
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
    haltFile: HALT_SENTINEL,
    // Never read the developer's real ~/.keel/overrides.json — a live
    // `keel allow <id> --once` grant would be consumed by these tests.
    overrideStore: { consume: () => false },
  }
  return new EnforcementPipeline(config)
}

function input(tool: string, args: Record<string, unknown>, session = 'threat', level: ProtectionLevel = 'balanced'): Parameters<EnforcementPipeline['evaluate']>[0] {
  return {
    tool,
    args,
    cwd: '/tmp/keel-threat-model',
    session_id: session,
    turn_number: 1,
    context_tokens: 0,
    level,
    context: 'local' as const,
    agent: 'test-agent',
    subagent_of: null,
  }
}

describe('agentic threat model (shipped defaults)', () => {
  beforeAll(() => {
    // Do not let a developer's live kill switch affect unrelated unit tests.
    // Mirrors pipeline.ts's own resolveHome()-based fallback.
    const sentinelPath = join(resolveHome(), '.keel', 'DISABLED')
    if (existsSync(sentinelPath)) rmSync(sentinelPath)
    // Same guard for a developer's live halt.
    const haltPath = join(resolveHome(), '.keel', 'HALTED')
    if (existsSync(haltPath)) rmSync(haltPath)
  })

  afterAll(() => {
    rmSafe(join(SENTINEL, '..'))
    rmSafe(join(HALT_SENTINEL, '..'))
  })

  describe('destructive commands (BUG 1 regression)', () => {
    const pipeline = makeDefaultsPipeline()
    it('blocks rm -rf on a real system path (floor denies on first hit, no warn grace)', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf /etc' }))).action).toBe('deny')
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf /etc' }))).action).toBe('deny')
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf ~/.ssh' }))).action).toBe('deny')
    })
    it('allows rm -rf on temp paths (no false positive)', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf /tmp/build-cache' }))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf /var/tmp/scratch' }))).action).toBe('allow')
    })
    it('allows rm -rf of node_modules (defaults exclude it)', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf node_modules' }))).action).toBe('allow')
    })
  })

  describe('git history manipulation', () => {
    const pipeline = makeDefaultsPipeline()
    it('prompt-gates a plain rebase', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'git rebase main' }))).action).toBe('prompt')
    })
    it('prompt-gates rebase --continue mid-rebase', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'git rebase --continue' }))).action).toBe('prompt')
    })
    it('prompt-gates soft/merge resets', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'git reset --soft HEAD~1' }))).action).toBe('prompt')
      expect((await pipeline.evaluate(input('Bash', { command: 'git reset --merge' }))).action).toBe('prompt')
    })
    it('denies force push without lease', async () => {
      // no-force-push is `level: protect` (Tier 1 floor), so it denies on
      // the FIRST hit at every dial — no warn-once grace.
      expect((await pipeline.evaluate(input('Bash', { command: 'git push --force origin feature' }))).action).toBe('deny')
      expect((await pipeline.evaluate(input('Bash', { command: 'git push --force origin feature' }))).action).toBe('deny')
      // no-force-push (Tier 1 protect) outranks no-push-to-main (Tier 2
      // prompt) so a force-push to a protected branch hits the floor
      // rule's deny, not the softer prompt (fixed this wave — previously
      // no-push-to-main shadowed no-force-push entirely for any
      // main-targeted push). Denies immediately, same as above.
      const main = await pipeline.evaluate(input('Bash', { command: 'git push --force origin main' }))
      expect(main.action).toBe('deny')
      expect(main.rule_id).toBe('no-force-push')
    })
    it('allows force-with-lease; force-with-lease to main still prompts', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'git push --force-with-lease origin feature' }))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'git push --force-with-lease origin main' }))).action).toBe('prompt')
    })
    it('prompt-gates deleting a remote branch', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'git push origin --delete old-branch' }))).action).toBe('prompt')
      expect((await pipeline.evaluate(input('Bash', { command: 'git push -d origin old-branch' }))).action).toBe('prompt')
      expect((await pipeline.evaluate(input('Bash', { command: 'git push origin development' }))).action).toBe('allow')
    })
  })

  describe('registry and release operations', () => {
    const pipeline = makeDefaultsPipeline()
    it('prompt-gates npm publish', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'npm publish' }))).action).toBe('prompt')
    })
    it('prompt-gates gh release create and delete', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'gh release create v1.0.0' }))).action).toBe('prompt')
      expect((await pipeline.evaluate(input('Bash', { command: 'gh release delete v0.9.0' }))).action).toBe('prompt')
    })
    it('prompt-gates repo deletion and transfer', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'gh repo delete some/repo' }))).action).toBe('prompt')
      expect((await pipeline.evaluate(input('Bash', { command: 'gh repo transfer some/repo target-org' }))).action).toBe('prompt')
    })
  })

  describe('product identity', () => {
    const pipeline = makeDefaultsPipeline()
    // The shipped defaults deliberately carry NO rule about keel's own
    // product name. That rule enforced this project's rename history on
    // strangers' repos, at priority 100, in a file keel writes to their
    // home directory. Renaming things is the user's business.
    it('does not enforce keel’s own naming history on a user’s repo', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: "sed -i '' 's/keel/something-else/g' docs.md" }))).action).toBe('allow')
    })
  })

  describe('claimed-done-without-evidence', () => {
    const pipeline = makeDefaultsPipeline()
    // source-change-requires-test ships as `mode: observe` (wave2-rules
    // re-tier: this repo's own standing requirements already state the
    // verification-culture expectation in prose; the hard enforcement now
    // burns in via observed_action before it interrupts commits/pushes
    // again). The tracker/boundary MECHANISM underneath is unchanged, but
    // the outer verdict is no longer pinned to 'allow': a matched `mode:
    // observe` rule records and evaluation CONTINUES (pipeline.ts's
    // evaluate()/violation() — OPA Gatekeeper dryrun / Cloudflare WAF
    // log-mode semantics), so a REAL rule on the same call now gets to
    // decide the verdict instead of being silently blinded. Both `git
    // commit` (must-sign-commits, mode: block, action: fix) and `git push
    // origin main` (no-push-to-main, mode: block, action: prompt) are
    // exactly such real rules — pre-fix they never even got the chance to
    // fire whenever this observe rule ALSO matched, which is a real
    // instance of the bug this fix removes, not a hypothetical. Observe
    // mode also does not replay the warn-then-deny ladder (it reports the
    // rule's raw boundary action every time), so both calls below show the
    // same observed_action.
    it('records (but does not enforce) a commit boundary after an untested source change', async () => {
      expect((await pipeline.evaluate(input('WriteFile', { filePath: 'src/app.ts' }))).action).toBe('allow')
      const first = await pipeline.evaluate(input('Bash', { command: 'git commit -m "done"' }))
      // must-sign-commits (real, mode: block) no longer blinded — it fires.
      expect(first.action).toBe('fix')
      expect(first.fix_result?.fixed).toContain('--signoff')
      expect(first.observed_action).toBe('warn')
      const second = await pipeline.evaluate(input('Bash', { command: 'git commit -m "done"' }))
      expect(second.action).toBe('fix')
      expect(second.observed_action).toBe('warn')
    })
    it('records (but does not enforce) a push boundary while the obligation is unsatisfied', async () => {
      const first = await pipeline.evaluate(input('Bash', { command: 'git push origin main' }))
      // no-push-to-main (real, mode: block) no longer blinded — it fires.
      expect(first.action).toBe('prompt')
      expect(first.observed_action).toBe('deny')
      const second = await pipeline.evaluate(input('Bash', { command: 'git push origin main' }))
      expect(second.action).toBe('prompt')
      expect(second.observed_action).toBe('deny')
    })
    it('clears the obligation after a passing test run', async () => {
      pipeline.markVerificationSatisfied(input('Bash', { command: 'npm test' }))
      const commit = await pipeline.evaluate(input('Bash', { command: 'git commit -m "done"' }))
      expect(commit.action).toBe('fix')
      expect(commit.fix_result?.fixed).toContain('git commit --signoff')
      expect((await pipeline.evaluate(input('Bash', { command: 'git push origin feature' }))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'git push origin main' }))).action).toBe('prompt')
    })
    it('does not double-append --signoff when already present', async () => {
      pipeline.markVerificationSatisfied(input('Bash', { command: 'npm test' }))
      const commit = await pipeline.evaluate(input('Bash', { command: 'git commit -m "done" --signoff' }))
      expect(commit.action).toBe('allow')
    })
  })

  describe('speed dial over the defaults', () => {
    it('sprint downgrades deny rules to warnings', async () => {
      // no-destructive-commands is now `level: protect` (wave2-rules Tier 1
      // floor) and so is deliberately EXEMPT from the sprint downgrade —
      // `rm -rf /etc` now denies immediately even at sprint, by design.
      // no-secrets-in-code stays a plain `level: sprint` deny, so it is the
      // rule that still demonstrates the ordinary sprint softening.
      const pipeline = makeDefaultsPipeline('sprint')
      expect((await pipeline.evaluate(input('WriteFile', { filePath: 'src/a.ts', content: 'const k = "AKIA1234567890ABCDEF"' }, 'threat', 'sprint'))).action).toBe('warn')
      expect((await pipeline.evaluate(input('WriteFile', { filePath: 'src/a.ts', content: 'const k = "AKIA1234567890ABCDEF"' }, 'threat', 'sprint'))).action).toBe('warn')
    })
    it('sprint no longer downgrades no-destructive-commands (now a protect floor, denies on first hit)', async () => {
      // level: protect exempts the ACTION from the sprint deny->warn
      // downgrade, AND makes the rule block-first at every dial (a floor
      // that warns once before blocking is not un-bypassable — proven live
      // by a force-push that reached the remote through that grace). So at
      // the sprint dial this now denies immediately, same as balanced/protect.
      const pipeline = makeDefaultsPipeline('sprint')
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf /etc' }, 'threat', 'sprint'))).action).toBe('deny')
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf /etc' }, 'threat', 'sprint'))).action).toBe('deny')
    })
    it('sprint never downgrades prompt gates', async () => {
      const pipeline = makeDefaultsPipeline('sprint')
      expect((await pipeline.evaluate(input('Bash', { command: 'git rebase main' }, 'threat', 'sprint'))).action).toBe('prompt')
      expect((await pipeline.evaluate(input('Bash', { command: 'npm publish' }, 'threat', 'sprint'))).action).toBe('prompt')
    })
    it('protect blocks deny rules on the FIRST violation (block-first dial)', async () => {
      const pipeline = makeDefaultsPipeline('protect')
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf /etc' }, 'threat', 'protect'))).action).toBe('deny')
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf /etc' }, 'threat', 'protect'))).action).toBe('deny')
    })
  })

  describe('custom rules are enforced identically', () => {
    it('a user filesystem rule blocks protected writes', async () => {
      const rules = parseRulesContent(`version: 1
rules:
  - id: protect-secrets
    type: filesystem
    paths: ["**/.env"]
    operations: [write, delete]
    action: deny
    message: "Secrets are read-only."
`, '/tmp/custom.md')
      const pipeline = new EnforcementPipeline({
        level: 'balanced', context: 'local',
        cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(),
        ruleHierarchy: { global: rules, user: null, project: null, local: null },
        ruleVersion: 1,
      })
      expect((await pipeline.evaluate(input('WriteFile', { filePath: '/tmp/proj/.env', operation: 'write' }))).action).toBe('warn')
      expect((await pipeline.evaluate(input('WriteFile', { filePath: '/tmp/proj/.env', operation: 'write' }))).action).toBe('deny')
      expect((await pipeline.evaluate(input('WriteFile', { filePath: '/tmp/proj/.env.example', operation: 'write' }))).action).toBe('allow')
    })
    it('a user rate rule throttles a token', async () => {
      const rules = parseRulesContent(`version: 1
rules:
  - id: token-flood
    type: rate
    match: "api-token"
    max_calls: 1
    window_seconds: 60
    action: deny
    message: "Too many calls"
`, '/tmp/custom2.md')
      const pipeline = new EnforcementPipeline({
        level: 'balanced', context: 'local',
        cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(),
        ruleHierarchy: { global: rules, user: null, project: null, local: null },
        ruleVersion: 1,
      })
      expect((await pipeline.evaluate(input('Bash', { command: 'call api-token' }))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'call api-token' }))).action).toBe('warn')
      expect((await pipeline.evaluate(input('Bash', { command: 'call api-token' }))).action).toBe('deny')
    })
  })

  describe('self-protection (keel must police its own enforcement)', () => {
    it('keel-control-gate denies keel disable/allow/level/install at every dial', async () => {
      for (const level of ['sprint', 'balanced', 'protect'] as ProtectionLevel[]) {
        for (const command of [
          'keel disable',
          'keel allow no-force-push --once',
          'keel level sprint --project',
          'keel install --opencode',
        ]) {
          // keel-control-gate is `level: protect` — it blocks on the FIRST
          // violation at every dial (sprint/balanced/protect alike), not
          // just at the protect dial.
          const p = makeDefaultsPipeline(level)
          expect((await p.evaluate(input('Bash', { command }, `self-${level}`, level))).action).toBe('deny')
          const second = await p.evaluate(input('Bash', { command }, `self-${level}`, level))
          expect(second.action).toBe('deny')
          expect(second.rule_id).toBe('keel-control-gate')
        }
      }
    })

    it('no-rules-tampering blocks writes to rules, sentinel, and plugin files at every dial', async () => {
      for (const level of ['sprint', 'balanced', 'protect'] as ProtectionLevel[]) {
        for (const target of [
          '/Users/tester/.keel/rules.yaml',
          '/Users/tester/code/keel/.keel/rules.yaml',
          '/Users/tester/code/keel/.keel.local.yaml',
          '/Users/tester/.config/keel/rules.yaml',
          '/Users/tester/.keel/DISABLED',
          '/Users/tester/.keel/HALTED',
          '/Users/tester/.opencode/plugins/keel-enforce.js',
        ]) {
          // no-rules-tampering is `level: protect` — it blocks on the FIRST
          // hit at every dial, the same as keel-control-gate above.
          const p = makeDefaultsPipeline(level)
          expect((await p.evaluate(input('write', { filePath: target, content: 'x' }, `tamper-${level}`, level))).action).toBe('deny')
          const second = await p.evaluate(input('write', { filePath: target, content: 'x' }, `tamper-${level}`, level))
          expect(second.action).toBe('deny')
          // no-rules-tampering (filesystem, matches the write tool's
          // `filePath` argument directly) is what actually fires for a
          // `write` tool call. no-self-protection-write (command) requires
          // a write verb or redirect in the COMMAND TEXT — a filesystem
          // tool's serialized args (`{"filePath":"..."}`, content stripped)
          // never contain one, so it never matches this shape of call
          // (confirmed after folding `.keel/DISABLED` into the verb-gated
          // group — see the write-context fixture below). Kept as a set
          // rather than a single expected id: the invariant under test is
          // "a protected path is blocked at every dial", not which floor
          // rule wins.
          expect(['no-rules-tampering', 'no-self-protection-write']).toContain(second.rule_id)
        }
      }
    })

    it('no-self-protection-write requires a write context — reads of .keel/DISABLED are allowed, writes still denied', async () => {
      const p = makeDefaultsPipeline('balanced')
      // Must-allow: harmless reads of the kill-switch sentinel through the
      // shell must not be denied. Before the fix, `.keel/DISABLED` was a
      // bare top-level alternative in no-self-protection-write's regex —
      // it matched the literal substring anywhere in the command, so a
      // plain read tripped the same deny as a write.
      for (const command of [
        'cat ~/.keel/DISABLED',
        'grep foo ~/.keel/DISABLED',
        'cat ~/.keel/HALTED',
        'grep foo ~/.keel/HALTED',
      ]) {
        const result = await p.evaluate(input('Bash', { command }, 'read-disabled'))
        expect(result.action, command).toBe('allow')
      }
      // Must-block (regression): genuine writes to the sentinel, and the
      // core.hooksPath bypass, must still deny.
      for (const command of [
        'echo x > ~/.keel/DISABLED',
        'tee ~/.keel/DISABLED <<< x',
        'cp x ~/.keel/DISABLED',
        'mv x ~/.keel/DISABLED',
        'echo x > ~/.keel/HALTED',
        'tee ~/.keel/HALTED <<< x',
        'rm ~/.keel/HALTED',
        'git config core.hooksPath /dev/null',
      ]) {
        const result = await p.evaluate(input('Bash', { command }, `write-disabled-${command}`))
        expect(result.action, command).toBe('deny')
      }
    })

    it('no-enforcer-removal blocks rm of the halt sentinel, same as the DISABLED sentinel', async () => {
      const p = makeDefaultsPipeline('balanced')
      // no-enforcer-removal is `level: protect` — denies on the first hit,
      // no warn-once grace, same as the plugin-delete case above.
      expect((await p.evaluate(input('bash', { command: 'rm ~/.keel/HALTED' }, 'rm-halted'))).action).toBe('deny')
      const second = await p.evaluate(input('bash', { command: 'rm ~/.keel/HALTED' }, 'rm-halted'))
      expect(second.action).toBe('deny')
      expect(second.rule_id).toBe('no-enforcer-removal')
    })

    it('keel-control-gate denies keel halt and keel resume the same way it denies keel disable', async () => {
      for (const level of ['sprint', 'balanced', 'protect'] as ProtectionLevel[]) {
        for (const command of ['keel halt', 'keel halt --reason "self-preservation"', 'keel resume']) {
          const p = makeDefaultsPipeline(level)
          expect((await p.evaluate(input('Bash', { command }, `self-halt-${level}-${command}`, level))).action).toBe('deny')
          const second = await p.evaluate(input('Bash', { command }, `self-halt-${level}-${command}`, level))
          expect(second.action).toBe('deny')
          // Asserted against a pipeline that is NOT itself halted — this is
          // the property that actually matters: an agent cannot use `keel
          // resume` to clear a halt it is under. (Separately, pipeline.test.ts's
          // 'Halt' describe block confirms that when a halt IS active, every
          // call — including one that would otherwise hit keel-control-gate —
          // denies with rule_id 'keel-halted' instead, because checkHalt()
          // short-circuits before any rule is ever evaluated.)
          expect(second.rule_id).toBe('keel-control-gate')
        }
      }
    })

    it('plugin file deletes are blocked even without -rf', async () => {
      const p = makeDefaultsPipeline('balanced')
      const target = '/Users/tester/.opencode/plugins/keel-enforce.js'
      // no-enforcer-removal is `level: protect` — denies on the first hit.
      expect((await p.evaluate(input('bash', { command: `rm ${target}` }, 'rm-plugin'))).action).toBe('deny')
      const second = await p.evaluate(input('bash', { command: `rm ${target}` }, 'rm-plugin'))
      expect(second.action).toBe('deny')
      expect(second.rule_id).toBe('no-enforcer-removal')
      expect((await p.evaluate(input('bash', { command: `rm -rf ${target}` }, 'rm-plugin'))).action).toBe('deny')
    })

    it('self-protection regexes catch Windows-style backslash paths, not just POSIX slashes', async () => {
      // Regression guard for a real gap found on windows-latest CI: both
      // rules' path fragments were hardcoded to forward slashes
      // (`[.]opencode/plugins/`), so `path.win32.join`-style backslash paths
      // silently bypassed the block on a real Windows machine. Deliberately
      // literal backslash strings here (not path.win32.join) so this test
      // exercises the Windows shape on every platform, including this
      // suite's own macOS/Linux CI legs.
      const p = makeDefaultsPipeline('balanced')
      const winPluginPath = 'C:\\Users\\tester\\.opencode\\plugins\\keel-enforce.js'
      expect((await p.evaluate(input('bash', { command: `rm ${winPluginPath}` }, 'rm-plugin-win'))).action).toBe('deny')
      const second = await p.evaluate(input('bash', { command: `rm ${winPluginPath}` }, 'rm-plugin-win'))
      expect(second.rule_id).toBe('no-enforcer-removal')

      const winKeelDir = 'rm -rf C:\\Users\\tester\\.keel'
      expect((await p.evaluate(input('bash', { command: winKeelDir }, 'rm-keel-win'))).action).toBe('deny')

      const winSettingsPath = 'C:\\Users\\tester\\project\\.claude\\settings.json'
      expect((await p.evaluate(input('bash', { command: `tee ${winSettingsPath} <<< x` }, 'tee-settings-win'))).action).toBe('deny')

      // Known-healthy negative on the same shape: an unrelated Windows path
      // must still be allowed, so this isn't just "any backslash denies".
      expect((await p.evaluate(input('bash', { command: 'rm C:\\Users\\tester\\project\\notes.txt' }, 'rm-unrelated-win'))).action).toBe('allow')
    })

    it('keel allow no longer grants a one-time override', async () => {
      const p = makeDefaultsPipeline('balanced')
      // A prior override grant exists, but the agent cannot self-approve via
      // the CLI — the command itself is denied before the store is
      // consulted. keel-control-gate is `level: protect`, so it denies on
      // the first hit rather than warning once.
      expect((await p.evaluate(input('Bash', { command: 'keel allow no-verify-bypass --once' }, 'self-allow'))).action).toBe('deny')
      const second = await p.evaluate(input('Bash', { command: 'keel allow no-verify-bypass --once' }, 'self-allow'))
      expect(second.action).toBe('deny')
      expect(second.rule_id).toBe('keel-control-gate')
    })
  })

  describe('floor rules cannot be weakened by scope (end-to-end)', () => {
    it('a .keel.local.yaml-shaped override of no-force-push (action: warn, no level) does not let a force push through', async () => {
      const globalRules = loadDefaultRules()
      globalRules.config.level = 'balanced'
      const localRules = parseRulesContent(`version: 1
rules:
  - id: no-force-push
    type: command
    match: "git push --force"
    action: warn
    message: "local override attempts to weaken the floor"
`, '/tmp/.keel.local.yaml')

      const config: PipelineConfig = {
        level: 'balanced',
        context: 'local' as RuleContext,
        cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(),
        sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(),
        ruleHierarchy: { global: globalRules, user: null, project: null, local: localRules },
        ruleVersion: 1,
        allowedFixTransforms: true,
        disableFile: SENTINEL,
        overrideStore: { consume: () => false },
      }
      const p = new EnforcementPipeline(config)
      // The floor (level: protect, action: deny) must win over the
      // .keel.local.yaml-shaped override (action: warn, no level) — a
      // local file must never be able to downgrade a floor rule.
      const result = await p.evaluate(input('Bash', { command: 'git push --force origin main' }, 'floor-e2e'))
      expect(result.action).toBe('deny')
      expect(result.rule_id).toBe('no-force-push')
    })
  })

  describe('verification honesty (satisfy must be real evidence)', () => {
    it('exit-code swallowing never satisfies the obligation', async () => {
      // source-change-requires-test is `mode: observe` (see the
      // claimed-done-without-evidence block above) — the underlying
      // tracker/discharge mechanism this test exercises is unchanged, only
      // the outer verdict is now allow+observed_action instead of
      // warn/deny. Observe mode does not replay the warn-then-deny ladder,
      // so both calls report the same observed_action.
      for (const fake of [
        'npm test || true',
        'npm test; exit 0',
        'npm run test | cat',
        'vitest --silent | grep PASS || true',
        'npm test ||:',
      ]) {
        const p = makeDefaultsPipeline('balanced')
        await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }, 'swallow'))
        p.markVerificationSatisfied(input('Bash', { command: fake }, 'swallow'))
        // The obligation must still be pending: the push boundary would
        // deny (recorded on observed_action), not actually block.
        const first = await p.evaluate(input('Bash', { command: 'git push origin feature' }, 'swallow'))
        expect(first.action, fake).toBe('allow')
        expect(first.observed_action, fake).toBe('deny')
        const second = await p.evaluate(input('Bash', { command: 'git push origin feature' }, 'swallow'))
        expect(second.action, fake).toBe('allow')
        expect(second.observed_action, fake).toBe('deny')
      }
      // A real run clears it.
      const p = makeDefaultsPipeline('balanced')
      await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }, 'swallow'))
      p.markVerificationSatisfied(input('Bash', { command: 'npm test -- --runInBand' }, 'swallow'))
      expect((await p.evaluate(input('Bash', { command: 'git push origin feature' }, 'swallow'))).action).toBe('allow')
    })

    it('package.json edits re-arm the obligation (test-script tampering is gated)', async () => {
      const p = makeDefaultsPipeline('balanced')
      await p.evaluate(input('write', { filePath: 'package.json', content: '{"scripts":{"test":"echo ok"}}' }, 'pkg'))
      // The tampered package.json write itself creates the obligation.
      const commit = await p.evaluate(input('Bash', { command: 'git commit -m "x"', cwd: '/tmp/keel-threat-model' }, 'pkg'))
      // must-sign-commits (real, mode: block) no longer blinded — it fires.
      expect(commit.action).toBe('fix')
      expect(commit.observed_action).toBe('warn')
      // A swallowed "npm test" must not clear it.
      p.markVerificationSatisfied(input('Bash', { command: 'npm test || true' }, 'pkg'))
      const push1 = await p.evaluate(input('Bash', { command: 'git push origin feature' }, 'pkg'))
      expect(push1.action).toBe('allow')
      expect(push1.observed_action).toBe('deny')
      const push2 = await p.evaluate(input('Bash', { command: 'git push origin feature' }, 'pkg'))
      expect(push2.action).toBe('allow')
      expect(push2.observed_action).toBe('deny')
      // A genuine run clears it.
      p.markVerificationSatisfied(input('Bash', { command: 'npm test' }, 'pkg'))
      expect((await p.evaluate(input('Bash', { command: 'git push origin feature' }, 'pkg'))).action).toBe('allow')
    })
  })
})
