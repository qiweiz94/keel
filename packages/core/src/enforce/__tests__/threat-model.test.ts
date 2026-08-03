import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, rmSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import type { PipelineConfig } from '../pipeline.js'
import type { ProtectionLevel, RuleContext } from '../../types.js'
import { parseRulesContent } from '../rule-parser.js'

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
  const legacy = src.match(/const LEGACY_PRODUCT_NAME = '([^']+)' \+ '([^']+)'/)
  let yaml = m[1]
  if (legacy) yaml = yaml.replaceAll('${LEGACY_PRODUCT_NAME}', `${legacy[1]}${legacy[2]}`)
  return parseRulesContent(yaml, 'default-rules')
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
    const sentinelPath = join(homedir(), '.keel', 'DISABLED')
    if (existsSync(sentinelPath)) rmSync(sentinelPath)
  })

  afterAll(() => {
    rmSync(join(SENTINEL, '..'), { recursive: true, force: true })
  })

  describe('destructive commands (BUG 1 regression)', () => {
    const pipeline = makeDefaultsPipeline()
    it('blocks rm -rf on a real system path', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf /etc' }))).action).toBe('warn')
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
      expect((await pipeline.evaluate(input('Bash', { command: 'git push --force origin feature' }))).action).toBe('warn')
      expect((await pipeline.evaluate(input('Bash', { command: 'git push --force origin feature' }))).action).toBe('deny')
      expect((await pipeline.evaluate(input('Bash', { command: 'git push --force origin main' }))).action).toBe('prompt')
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
    it('denies renaming keel back to the legacy name', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: "sed -i '' 's/keel/ai-enforce/g' docs.md" }))).action).toBe('warn')
      expect((await pipeline.evaluate(input('Bash', { command: "sed -i '' 's/keel/ai-enforce/g' docs.md" }))).action).toBe('deny')
    })
  })

  describe('claimed-done-without-evidence', () => {
    const pipeline = makeDefaultsPipeline()
    it('warns on commit after an untested source change (commit boundary is warn-only)', async () => {
      expect((await pipeline.evaluate(input('WriteFile', { filePath: 'src/app.ts' }))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'git commit -m "done"' }))).action).toBe('warn')
      expect((await pipeline.evaluate(input('Bash', { command: 'git commit -m "done"' }))).action).toBe('warn')
    })
    it('denies push while the obligation is unsatisfied', async () => {
      expect((await pipeline.evaluate(input('Bash', { command: 'git push origin main' }))).action).toBe('warn')
      expect((await pipeline.evaluate(input('Bash', { command: 'git push origin main' }))).action).toBe('deny')
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
      const pipeline = makeDefaultsPipeline('sprint')
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf /etc' }, 'threat', 'sprint'))).action).toBe('warn')
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf /etc' }, 'threat', 'sprint'))).action).toBe('warn')
    })
    it('sprint never downgrades prompt gates', async () => {
      const pipeline = makeDefaultsPipeline('sprint')
      expect((await pipeline.evaluate(input('Bash', { command: 'git rebase main' }, 'threat', 'sprint'))).action).toBe('prompt')
      expect((await pipeline.evaluate(input('Bash', { command: 'npm publish' }, 'threat', 'sprint'))).action).toBe('prompt')
    })
    it('protect blocks deny rules after the first warning', async () => {
      const pipeline = makeDefaultsPipeline('protect')
      expect((await pipeline.evaluate(input('Bash', { command: 'rm -rf /etc' }, 'threat', 'protect'))).action).toBe('warn')
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
          // First violation warns, second denies (fresh pipeline per case so
          // escalation state never leaks across assertions).
          const p = makeDefaultsPipeline(level)
          expect((await p.evaluate(input('Bash', { command }, `self-${level}`, level))).action).toBe('warn')
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
          '/Users/tester/.opencode/plugins/keel-enforce.js',
        ]) {
          const p = makeDefaultsPipeline(level)
          expect((await p.evaluate(input('write', { filePath: target, content: 'x' }, `tamper-${level}`, level))).action).toBe('warn')
          const second = await p.evaluate(input('write', { filePath: target, content: 'x' }, `tamper-${level}`, level))
          expect(second.action).toBe('deny')
          expect(second.rule_id).toBe('no-rules-tampering')
        }
      }
    })

    it('plugin file deletes are blocked even without -rf', async () => {
      const p = makeDefaultsPipeline('balanced')
      const target = '/Users/tester/.opencode/plugins/keel-enforce.js'
      expect((await p.evaluate(input('bash', { command: `rm ${target}` }, 'rm-plugin'))).action).toBe('warn')
      const second = await p.evaluate(input('bash', { command: `rm ${target}` }, 'rm-plugin'))
      expect(second.action).toBe('deny')
      expect(second.rule_id).toBe('no-enforcer-removal')
      expect((await p.evaluate(input('bash', { command: `rm -rf ${target}` }, 'rm-plugin'))).action).toBe('deny')
    })

    it('keel allow no longer grants a one-time override', async () => {
      const p = makeDefaultsPipeline('balanced')
      // A prior override grant exists, but the agent cannot self-approve via
      // the CLI — the command itself is denied before the store is consulted.
      expect((await p.evaluate(input('Bash', { command: 'keel allow no-verify-bypass --once' }, 'self-allow'))).action).toBe('warn')
      const second = await p.evaluate(input('Bash', { command: 'keel allow no-verify-bypass --once' }, 'self-allow'))
      expect(second.action).toBe('deny')
      expect(second.rule_id).toBe('keel-control-gate')
    })
  })

  describe('verification honesty (satisfy must be real evidence)', () => {
    it('exit-code swallowing never satisfies the obligation', async () => {
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
        // The obligation must still be pending: the push boundary (deny)
        // first violation warns, repeat denies.
        expect((await p.evaluate(input('Bash', { command: 'git push origin feature' }, 'swallow'))).action).toBe('warn')
        expect((await p.evaluate(input('Bash', { command: 'git push origin feature' }, 'swallow'))).action).toBe('deny')
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
      expect((await p.evaluate(input('Bash', { command: 'git commit -m "x"', cwd: '/tmp/keel-threat-model' }, 'pkg'))).action).toBe('warn')
      // A swallowed "npm test" must not clear it.
      p.markVerificationSatisfied(input('Bash', { command: 'npm test || true' }, 'pkg'))
      expect((await p.evaluate(input('Bash', { command: 'git push origin feature' }, 'pkg'))).action).toBe('warn')
      expect((await p.evaluate(input('Bash', { command: 'git push origin feature' }, 'pkg'))).action).toBe('deny')
      // A genuine run clears it.
      p.markVerificationSatisfied(input('Bash', { command: 'npm test' }, 'pkg'))
      expect((await p.evaluate(input('Bash', { command: 'git push origin feature' }, 'pkg'))).action).toBe('allow')
    })
  })
})
