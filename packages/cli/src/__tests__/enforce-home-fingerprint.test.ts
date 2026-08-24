import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateToolCall, initEnforce } from '../commands/enforce.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * `initEnforce()`'s `ruleFingerprint` used to widen the fingerprint to
 * include the global rule tier via `process.env.HOME || '~'` instead of
 * `resolveHome()` (KEEL_HOME > HOME > os.homedir()). Two distinct,
 * real-world-observed failures followed from that mismatch, covered one
 * per test below:
 *
 *  1. Under `KEEL_HOME`, an edit to the ACTIVE global rules.yaml (the one
 *     `loadRuleHierarchy` — which correctly calls `resolveHome()` — reads
 *     from) was invisible to the fingerprint: the pipeline's cached hash
 *     never changed, so `checkRuleVersion()` never re-triggered
 *     `reloadRules()`, and a long-lived caller (`keel test`, `keel allow`,
 *     an embedded host) kept enforcing a stale global ruleset.
 *
 *  2. When `HOME` differs from `KEEL_HOME` (a real machine with a sandboxed
 *     `KEEL_HOME` session), an unrelated edit to the real `~/.keel/
 *     rules.yaml` changed `process.env.HOME`'s file on disk and so changed
 *     the OLD fingerprint even though that file has nothing to do with the
 *     active (KEEL_HOME) ruleset — triggering a spurious reload that wipes
 *     the warn-once-then-block escalation state
 *     (`EnforcementPipeline`'s `denyFirstTime`, cleared on every detected
 *     rule change) for a session it should never have touched.
 *
 * Both tests set KEEL_HOME and HOME to two DIFFERENT temp directories (never
 * relying on KEEL_HOME alone to prove isolation — a bare HOME-only or
 * KEEL_HOME-only setup could pass by accident even with the old bug) and
 * never touch the real ~/.keel.
 */

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const GLOBAL_HEADER = 'version: 1\n'

function protectDenyRule(id: string, match: string): string {
  return `${GLOBAL_HEADER}rules:
  - id: ${id}
    type: command
    match: "${match}"
    level: protect
    action: deny
    message: "blocked"
`
}

function balancedDenyRule(id: string, match: string): string {
  return `${GLOBAL_HEADER}level: balanced
rules:
  - id: ${id}
    type: command
    match: "${match}"
    action: deny
    message: "blocked"
`
}

describe('enforce.ts ruleFingerprint honors KEEL_HOME (not process.env.HOME)', () => {
  let project: string
  let keelHome: string
  let sysHome: string
  let previousKeelHome: string | undefined
  let previousHome: string | undefined
  let previousStateDir: string | undefined

  beforeEach(() => {
    project = tempDir('keel-fp-project-')
    keelHome = tempDir('keel-fp-keelhome-')
    sysHome = tempDir('keel-fp-syshome-')
    mkdirSync(join(project, '.keel'), { recursive: true })
    mkdirSync(join(keelHome, '.keel'), { recursive: true })
    mkdirSync(join(sysHome, '.keel'), { recursive: true })
    // Empty project ruleset so only the global tier is in play.
    writeFileSync(join(project, '.keel', 'rules.yaml'), 'version: 1\nrules: []\n')

    previousKeelHome = process.env.KEEL_HOME
    previousHome = process.env.HOME
    previousStateDir = process.env.KEEL_STATE_DIR
    // Belt-and-suspenders per the fix-verification instructions: HOME and
    // KEEL_HOME are both set explicitly (to two DIFFERENT dirs here, on
    // purpose, so a test that only inspects one of them can't pass by
    // accident).
    process.env.KEEL_HOME = keelHome
    process.env.HOME = sysHome
    delete process.env.KEEL_STATE_DIR
  })

  afterEach(() => {
    if (previousKeelHome === undefined) delete process.env.KEEL_HOME
    else process.env.KEEL_HOME = previousKeelHome
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousStateDir === undefined) delete process.env.KEEL_STATE_DIR
    else process.env.KEEL_STATE_DIR = previousStateDir
    rmSafe(project); rmSafe(keelHome); rmSafe(sysHome)
  })

  it('picks up a mid-session edit to the ACTIVE (KEEL_HOME) global rules.yaml', async () => {
    // Starts with no global rule at all.
    writeFileSync(join(keelHome, '.keel', 'rules.yaml'), 'version: 1\nrules: []\n')
    initEnforce(project)

    const before = await evaluateToolCall('Bash', { command: 'stale-cache-token' }, { cwd: project })
    expect(before.action).toBe('allow')

    // Add a block-first global rule under KEEL_HOME — the directory
    // resolveHome() actually resolves to.
    writeFileSync(join(keelHome, '.keel', 'rules.yaml'), protectDenyRule('global-guard', 'stale-cache-token'))

    const after = await evaluateToolCall('Bash', { command: 'stale-cache-token' }, { cwd: project })
    // With the old `process.env.HOME || '~'` fingerprint, this edit was
    // invisible (HOME's file on disk never changed) and `after.action`
    // stayed 'allow' — a stale cache silently ignoring an active edit.
    expect(after.action).toBe('deny')
  })

  it('does not reset warn-escalation state on an unrelated edit under HOME when HOME != KEEL_HOME', async () => {
    // A balanced-dial deny rule warns once, then blocks — verifying that
    // escalation survives is what detects a SPURIOUS reload (checkRuleVersion
    // clears denyFirstTime on any detected hash change).
    writeFileSync(join(keelHome, '.keel', 'rules.yaml'), balancedDenyRule('warn-then-block', 'warn-token'))
    // Seed something under sysHome (== HOME) too, so an edit below is a
    // genuine content change and not a no-op.
    writeFileSync(join(sysHome, '.keel', 'rules.yaml'), 'version: 1\nrules: []\n')
    initEnforce(project, { level: 'balanced' })

    const first = await evaluateToolCall('Bash', { command: 'warn-token' }, { cwd: project })
    expect(first.action).toBe('warn')

    // Edit the file under HOME (sysHome), which is NOT KEEL_HOME and plays
    // no role in the active ruleset at all.
    writeFileSync(join(sysHome, '.keel', 'rules.yaml'), protectDenyRule('unrelated', 'unrelated-token'))

    const second = await evaluateToolCall('Bash', { command: 'warn-token' }, { cwd: project })
    // With the old `process.env.HOME || '~'` fingerprint, this unrelated
    // edit changed the computed hash, triggered a spurious reload, and
    // cleared denyFirstTime — so the SAME call would incorrectly warn
    // again instead of escalating to a block.
    expect(second.action).toBe('deny')
  })
})
