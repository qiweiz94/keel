import { describe, it, expect } from 'vitest'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent } from '../rule-parser.js'
import type { EnforceInput } from '../../types.js'
import type { RuleContext } from '../../types.js'

// Regression coverage for the bare-star glob bug in EnforcementPipeline's
// private pathMatches() (packages/core/src/enforce/pipeline.ts).
//
// Root cause: the double-star branch built its regex by first escaping
// regex-special characters with a class that does NOT include the star,
// then tried to convert a glob star to "[^/]*" by matching a literal
// escaped-star sequence. Because the star was never escaped in the first
// step, that second replace never fires -- a bare star survives into the
// final regex as a raw regex quantifier applied to whatever character
// precedes it, not as "match any run of characters in this path segment".
// E.g. the pattern for ".env" files with a trailing star compiled to
// something whose trailing quantifier applied to the "v" before it
// (zero-or-more "v"), so ".env.local" (anything after "env") never matched.
//
// This file exercises the bug through the public evaluate() surface
// (pathMatches is private) using filesystem-type rules shaped exactly like
// the ones DEFAULT_RULES_YAML ships in packages/cli/src/commands/install.ts.

function buildPipeline(yaml: string): EnforcementPipeline {
  const rules = parseRulesContent(yaml, '/tmp/glob-matching-rules.yaml')
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local' as RuleContext,
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: { global: null, user: null, project: rules, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
  })
}

function writeInput(path: string, session: string): EnforceInput {
  return {
    tool: 'Write',
    args: { path, content: 'x' },
    cwd: '/repo',
    session_id: session,
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'test',
    subagent_of: null,
  }
}

// The top-level `level: protect` dial (read by effectiveLevel() from
// config.level, NOT the per-rule `level:` field — see pipeline.ts's
// violation()) makes a deny rule block on the FIRST violation instead of
// warn-then-block, which keeps each case here a single evaluate() call.
const SECRET_FILES_RULE = `version: 1
level: protect
rules:
  - id: no-secret-files
    type: filesystem
    paths:
      - "**/.env*"
      - "**/*.pem"
      - "**/*.pfx"
      - "**/*.p12"
      - "**/id_rsa*"
      - "**/id_ed25519*"
    exclude:
      - "**/.env.example"
      - "**/.env.sample"
      - "**/.env.test"
    action: deny
    level: protect
    message: "Writing or modifying credential files is blocked."
`

describe('pathMatches — bare * glob semantics (filesystem rules)', () => {
  it('matches .env.local against **/.env*', async () => {
    const pipeline = buildPipeline(SECRET_FILES_RULE)
    const result = await pipeline.evaluate(writeInput('/repo/.env.local', 's1'))
    expect(result.action).toBe('deny')
  })

  it('matches .env.production against **/.env*', async () => {
    const pipeline = buildPipeline(SECRET_FILES_RULE)
    const result = await pipeline.evaluate(writeInput('/repo/.env.production', 's2'))
    expect(result.action).toBe('deny')
  })

  it('matches id_rsa.pub against **/id_rsa*', async () => {
    const pipeline = buildPipeline(SECRET_FILES_RULE)
    const result = await pipeline.evaluate(writeInput('/repo/id_rsa.pub', 's3'))
    expect(result.action).toBe('deny')
  })

  it('matches id_ed25519.pub against **/id_ed25519*', async () => {
    const pipeline = buildPipeline(SECRET_FILES_RULE)
    const result = await pipeline.evaluate(writeInput('/repo/id_ed25519.pub', 's4'))
    expect(result.action).toBe('deny')
  })

  it('matches a nested foo.pem against **/*.pem', async () => {
    const pipeline = buildPipeline(SECRET_FILES_RULE)
    const result = await pipeline.evaluate(writeInput('/repo/nested/dir/foo.pem', 's5'))
    expect(result.action).toBe('deny')
  })

  it('matches cert.pfx and cert.p12', async () => {
    const pipeline = buildPipeline(SECRET_FILES_RULE)
    const pfx = await pipeline.evaluate(writeInput('/repo/cert.pfx', 's6'))
    const p12 = await pipeline.evaluate(writeInput('/repo/cert.p12', 's7'))
    expect(pfx.action).toBe('deny')
    expect(p12.action).toBe('deny')
  })

  // ── must-NOT-match: the wildcard must not overreach ──

  it('does not match env.txt against **/.env* (no leading dot, so no segment match)', async () => {
    const pipeline = buildPipeline(SECRET_FILES_RULE)
    const result = await pipeline.evaluate(writeInput('/repo/env.txt', 's8'))
    expect(result.action).toBe('allow')
  })

  it('does not match foo.pemx against **/*.pem (extension must match exactly, not as a prefix)', async () => {
    const pipeline = buildPipeline(SECRET_FILES_RULE)
    const result = await pipeline.evaluate(writeInput('/repo/foo.pemx', 's9'))
    expect(result.action).toBe('allow')
  })

  it('does not let * cross a path segment boundary', async () => {
    const pipeline = buildPipeline(SECRET_FILES_RULE)
    // "*" in "id_rsa*" must not match "id_rsa/subfile" by crossing the "/" —
    // only "**" may cross segments.
    const result = await pipeline.evaluate(writeInput('/repo/id_rsa/subfile', 's10'))
    expect(result.action).toBe('allow')
  })

  // ── literal-dot escaping: "." in a pattern must mean a literal dot ──

  it('does not treat the "." in .env* as "any character"', async () => {
    const pipeline = buildPipeline(SECRET_FILES_RULE)
    // If "." were unescaped, "Xenv.local" (any-char + "env" + ...) would
    // wrongly match "**/.env*".
    const result = await pipeline.evaluate(writeInput('/repo/Xenv.local', 's11'))
    expect(result.action).toBe('allow')
  })

  // ── exclude list must still carve out template/sample/test files ──

  it('still allows .env.example, .env.sample, .env.test via the exclude list', async () => {
    const pipeline = buildPipeline(SECRET_FILES_RULE)
    const example = await pipeline.evaluate(writeInput('/repo/.env.example', 's12'))
    const sample = await pipeline.evaluate(writeInput('/repo/.env.sample', 's13'))
    const test = await pipeline.evaluate(writeInput('/repo/.env.test', 's14'))
    expect(example.action).toBe('allow')
    expect(sample.action).toBe('allow')
    expect(test.action).toBe('allow')
  })

  // ── previously-passing behavior must not regress ──

  it('still matches multi-segment **/*.log across directories', async () => {
    const pipeline = buildPipeline(`version: 1
level: protect
rules:
  - id: log-guard
    type: filesystem
    paths: ["**/*.log"]
    action: deny
    message: "no logs"
`)
    const nested = await pipeline.evaluate(writeInput('/repo/src/deep/x.log', 's15'))
    const source = await pipeline.evaluate(writeInput('/repo/src/x.ts', 's16'))
    expect(nested.action).toBe('deny')
    expect(source.action).toBe('allow')
  })

  it('still matches **/.ssh/** across any depth', async () => {
    const pipeline = buildPipeline(`version: 1
level: protect
rules:
  - id: ssh-guard
    type: filesystem
    paths: ["**/.ssh/**"]
    action: deny
    message: "no ssh dir writes"
`)
    const direct = await pipeline.evaluate(writeInput('/repo/.ssh/id_rsa', 's17'))
    const nested = await pipeline.evaluate(writeInput('/repo/nested/.ssh/known_hosts', 's18'))
    expect(direct.action).toBe('deny')
    expect(nested.action).toBe('deny')
  })
})

// Regression coverage for the negated-path OR/AND bug fixed alongside the
// Windows path-normalization rewrite: a `paths` list mixing a positive
// pattern with a `!`-negated one used to run through a single `.some()`,
// so it matched on EITHER "matches the positive" OR "isn't matched by the
// negative" — the latter is true for almost every value, so the negation
// inverted into matching nearly everything instead of excluding a subtree
// from the positive match. No shipped rule uses this shape today (see
// install.ts's no-outside-project-writes rationale, which explicitly
// rejected a negated-allowlist pattern), but the single-entry
// `["!/src/*"]` case in pipeline.test.ts alone doesn't exercise the
// mixed-list interaction, so it stayed broken silently.
describe('pathMatches — negated path combined with a positive pattern', () => {
  const TS_EXCEPT_NODE_MODULES = `version: 1
level: protect
rules:
  - id: ts-outside-node-modules
    type: filesystem
    paths: ["**/*.ts", "!**/node_modules/**"]
    action: deny
    message: "no .ts writes outside node_modules"
`

  it('fires for a .ts file outside node_modules (positive matches, negative does not exclude it)', async () => {
    const pipeline = buildPipeline(TS_EXCEPT_NODE_MODULES)
    const result = await pipeline.evaluate(writeInput('/repo/src/a.ts', 's19'))
    expect(result.action).toBe('deny')
  })

  it('does NOT fire for a .ts file inside node_modules (negative excludes despite the positive matching)', async () => {
    const pipeline = buildPipeline(TS_EXCEPT_NODE_MODULES)
    const result = await pipeline.evaluate(writeInput('/repo/node_modules/pkg/a.ts', 's20'))
    expect(result.action).toBe('allow')
  })

  it('does NOT fire for a non-.ts file outside node_modules (proves positives are still REQUIRED, not short-circuited to true by the negated entry\'s presence)', async () => {
    const pipeline = buildPipeline(TS_EXCEPT_NODE_MODULES)
    const result = await pipeline.evaluate(writeInput('/repo/src/a.md', 's21'))
    expect(result.action).toBe('allow')
  })
})
