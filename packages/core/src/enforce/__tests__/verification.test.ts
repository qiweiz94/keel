import { describe, it, expect, afterAll } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent } from '../rule-parser.js'
import { pathFromPatch, argPath } from '../arg-utils.js'
import type { RuleContext } from '../../types.js'

// Agentic tool-name coverage: opencode's real file tools are lowercase
// `write`/`edit`/`apply_patch` and its shell tool is `bash`. The verification
// trigger must fire on them (F1), satisfy through `bash` (F1), and derive the
// target path from apply_patch body markers (F3).

const VERIFY_RULES = `version: 1
rules:
  - id: %ID%
    type: verification
    trigger:
      tools: [write, edit, apply_patch]
      path: "src/"
      pattern: "src/"
    satisfy:
      tools: [bash]
      pattern: "(npm test|npm run test)"
    boundaries:
      commit:
        pattern: "git commit"
        action: warn
      push:
        pattern: "git push"
        action: deny
    verification_window_seconds: 300
    action: deny
    message: "Test required."
`

function makeVerifyPipeline(id: string): EnforcementPipeline {
  const rules = parseRulesContent(VERIFY_RULES.replace('%ID%', id), '/tmp/verify.yaml')
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

function input(tool: string, args: Record<string, unknown>, session = 'verify') {
  return {
    tool,
    args,
    cwd: '/tmp/project',
    session_id: session,
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced' as const,
    context: 'local' as const,
    agent: 'test',
    subagent_of: null,
  }
}

let tmpDir = ''
function tmpFile(name: string): string {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'keel-verify-'))
  return join(tmpDir, name)
}

describe('Verification tracker (agentic tool names)', () => {
  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('write to src/ creates the obligation; commit warns, push escalates warn→deny', async () => {
    const p = makeVerifyPipeline('vf-write')
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'export const a = 1' }))
    // The commit boundary is declared `warn` — constant warn, no escalation.
    expect((await p.evaluate(input('bash', { command: 'git commit -m "wip"' }))).action).toBe('warn')
    expect((await p.evaluate(input('bash', { command: 'git commit -m "wip"' }))).action).toBe('warn')
    // The push boundary is declared `deny` — first violation warns, then blocks.
    expect((await p.evaluate(input('bash', { command: 'git push origin main' }))).action).toBe('warn')
    expect((await p.evaluate(input('bash', { command: 'git push origin main' }))).action).toBe('deny')
  })

  it('apply_patch with a path marker creates the obligation', async () => {
    const p = makeVerifyPipeline('vf-patch')
    await p.evaluate(input('apply_patch', { patchText: '*** Add File: src/new.ts\n+export const n = 1\n' }))
    expect((await p.evaluate(input('bash', { command: 'git commit -m "wip"' }))).action).toBe('warn')
  })

  it('write-shape fallback: unknown tool writing file content still triggers', async () => {
    const p = makeVerifyPipeline('vf-shape')
    // An MCP-style tool name that is not in the trigger list still carries
    // write-shaped args (filePath + content), so it must create the obligation.
    await p.evaluate(input('mcp__fs__put', { filePath: 'src/x.ts', content: 'x' }))
    expect((await p.evaluate(input('bash', { command: 'git commit -m "wip"' }))).action).toBe('warn')
  })

  it('successful test run via bash clears the obligation; --help does not', async () => {
    const p = makeVerifyPipeline('vf-satisfy')
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    // A help flag is not evidence the suite ran.
    await p.evaluate(input('bash', { command: 'npm test --help' }))
    expect((await p.evaluate(input('bash', { command: 'git push origin main' }))).action).toBe('warn')
    expect((await p.evaluate(input('bash', { command: 'git push origin main' }))).action).toBe('deny')
    // A real run clears it (the integration invokes markVerificationSatisfied
    // after a successful command — pipeline.test.ts:218 shows the hook).
    await p.evaluate(input('bash', { command: 'npm run test' }))
    p.markVerificationSatisfied(input('bash', { command: 'npm run test' }))
    expect((await p.evaluate(input('bash', { command: 'git push origin main' }))).action).toBe('allow')
  })

  it('pathFromPatch extracts the target from Add/Update/Delete/Move markers', () => {
    expect(pathFromPatch('*** Add File: src/x.ts\n+code\n')).toBe('src/x.ts')
    expect(pathFromPatch('*** Update File: docs/readme.md\n-old\n+new\n')).toBe('docs/readme.md')
    expect(pathFromPatch('*** Delete File: tmp.txt\n')).toBe('tmp.txt')
    expect(pathFromPatch('*** Move File: src/a.ts -> src/b.ts\n')).toBe('src/a.ts -> src/b.ts')
    expect(pathFromPatch('no marker here')).toBe('')
    expect(pathFromPatch('')).toBe('')
    expect(pathFromPatch(42 as unknown as string)).toBe('')
  })

  it('argPath prefers explicit path args over patch markers', () => {
    expect(argPath({ filePath: 'src/x.ts' })).toBe('src/x.ts')
    expect(argPath({ patchText: '*** Update File: other.ts\n-old\n+new\n' })).toBe('other.ts')
    expect(argPath({ filePath: 'src/x.ts', patchText: '*** Update File: other.ts\n' })).toBe('src/x.ts')
    expect(argPath({})).toBe('')
  })
})

describe('Content rules (disk scan)', () => {
  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  const CONTENT_RULES = `version: 1
rules:
  - id: %ID%
    type: content
    patterns:
      - regex: "PRIVATE_KEY"
    action: deny
    message: "No secrets in files."
`

  function makeContentPipeline(id: string): EnforcementPipeline {
    const rules = parseRulesContent(CONTENT_RULES.replace('%ID%', id), '/tmp/content.yaml')
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

  function fileInput(p: EnforcementPipeline, filePath: string, content: string, session = 'scan') {
    return p.evaluate(input('write', { filePath, content }, session))
  }

  it('disk scan catches a secret written by an external process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-disk-'))
    const notes = join(dir, 'notes.txt')
    writeFileSync(notes, 'PRIVATE_KEY_abc\n')
    const p = makeContentPipeline('cf-external')
    // MCP-style write carrying the payload under `data` (no inline content
    // keys): the disk scan is the only source of content, and the externally
    // written secret must be caught. Payloads vary per call like real writes
    // (the action cache keys on exact args, so identical clean payloads would
    // return a cached allow and never re-scan).
    const dataInput = (path: string, data: string) => p.evaluate(input('mcp__fs__write', { filePath: path, data }, 'scan'))
    expect((await dataInput(notes, 'clean payload 1')).action).toBe('warn')
    // Already-scanned file: unchanged on disk, nothing new to flag.
    expect((await dataInput(notes, 'clean payload 2')).action).toBe('allow')
    // Another external change re-arms the scan; the rule already escalated
    // from the first violation, so the next write denies immediately. The
    // scan re-baselines its hash on the violation path, so a subsequent write
    // against the now-known file state passes until the file changes again.
    writeFileSync(notes, 'PRIVATE_KEY_xyz\n')
    expect((await dataInput(notes, 'clean payload 3')).action).toBe('deny')
    expect((await dataInput(notes, 'clean payload 4')).action).toBe('allow')
    rmSync(dir, { recursive: true, force: true })
  })

  it('inline content is always checked, even overwriting an already-scanned file (F9 regression)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-f9-'))
    const target = join(dir, 'target.ts')
    writeFileSync(target, 'export const x = 1\n')
    const p = makeContentPipeline('cf-inline')
    // First write with inline secret: flagged.
    expect((await fileInput(p, target, 'PRIVATE_KEY_inline_1', 'f9')).action).toBe('warn')
    // Overwrite with another inline secret: must STILL be flagged even though
    // the on-disk file was marked unchanged by the previous scan.
    expect((await fileInput(p, target, 'PRIVATE_KEY_inline_2', 'f9')).action).toBe('deny')
    rmSync(dir, { recursive: true, force: true })
  })
})
