import { describe, it, expect } from 'vitest'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent } from '../rule-parser.js'
import type { EnforceInput } from '../../types.js'

/**
 * Regression for the most severe finding in the pipeline audit: the generic
 * `type: content` branch (evaluateTiers()'s Tier 5) built the text it scans
 * from `args.content || args.text || patchText` only — it never read
 * `args.newString`, the field Claude Code's `Edit(oldString, newString)`
 * tool call uses to carry the new file content. A `no-secrets-in-code`
 * DENY rule (a Tier-2 floor-adjacent content gate in the shipped defaults)
 * was therefore completely blind to a secret introduced via `Edit`, while
 * the IDENTICAL secret via `Write` was correctly caught — a live bypass of
 * a deny-tier secret-detection rule through the single most common real
 * edit tool. The sibling `type: oracle` branch already read `args.newString`
 * (and `args.new_string`) correctly; this was a clear omission in the
 * content branch, not a design choice.
 *
 * EnforcementPipeline defaults `overrideStore` to a FileRuleOverrideStore
 * rooted at the real homedir() when none is supplied; an in-memory stub
 * keeps this suite off the real filesystem (see stuck.test.ts's
 * `noopOverrideStore`, same fix, same root cause).
 */
const noopOverrideStore = { consume: () => false, peek: () => null, list: () => ({}) }

const NO_SECRETS_RULE = `version: 1
rules:
  - id: no-secrets-in-code
    type: content
    patterns:
      - regex: "AKIA[0-9A-Z]{16}"
        redact_span: true
    action: deny
    message: "Hardcoded credentials must not be written."
`

function makePipeline(): EnforcementPipeline {
  const rules = parseRulesContent(NO_SECRETS_RULE, '/tmp/edit-shaped-content-rules.yaml')
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    overrideStore: noopOverrideStore,
    ruleHierarchy: { global: rules, user: null, project: null, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
  })
}

function input(tool: string, args: Record<string, unknown>): EnforceInput {
  return {
    tool,
    args,
    cwd: '/tmp/edit-shaped-content-project',
    session_id: 'edit-shaped-content',
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'test',
    subagent_of: null,
  }
}

const SECRET = 'AKIAABCDEFGHIJKLMNOP'

describe('type: content rules see Edit-shaped tool calls (args.newString), not just Write-shaped ones', () => {
  // no-secrets-in-code ships as `level: sprint` (install.ts), not a floor —
  // so like every other non-floor deny rule it warns on its first hit and
  // blocks from the second (see simple-rules.test.ts's identical two-call
  // shape for the same escalation). What matters for THIS bug is whether
  // the rule is REACHED at all: pre-fix, an Edit-shaped call never matched
  // ANYTHING (action: allow, rule_id: null) on either call, because
  // `inlineContent` never looked at `args.newString`.

  it('MUST-DENY: a hardcoded AWS key inserted via an Edit(oldString, newString) call is caught by no-secrets-in-code', async () => {
    const p = makePipeline()
    const editCall = () => input('Edit', {
      file_path: 'src/config.ts',
      oldString: 'const AWS_KEY = process.env.AWS_KEY',
      newString: `const AWS_KEY = '${SECRET}'`,
    })
    const first = await p.evaluate(editCall())
    expect(first.rule_id).toBe('no-secrets-in-code')
    expect(first.action).toBe('warn')
    const second = await p.evaluate(editCall())
    expect(second.action).toBe('deny')
    expect(second.rule_id).toBe('no-secrets-in-code')
  })

  it('sanity: the identical secret via a Write(content) call is caught too — proves the fixture rule itself works, isolating the bug to the Edit shape specifically', async () => {
    const p = makePipeline()
    const writeCall = () => input('Write', {
      file_path: 'src/config.ts',
      content: `const AWS_KEY = '${SECRET}'`,
    })
    const first = await p.evaluate(writeCall())
    expect(first.rule_id).toBe('no-secrets-in-code')
    const second = await p.evaluate(writeCall())
    expect(second.action).toBe('deny')
    expect(second.rule_id).toBe('no-secrets-in-code')
  })

  it('an Edit call whose newString is clean allows normally (no false positive introduced by reading newString)', async () => {
    const p = makePipeline()
    const r = await p.evaluate(input('Edit', {
      file_path: 'src/config.ts',
      oldString: 'const AWS_KEY = old_value',
      newString: 'const AWS_KEY = process.env.AWS_KEY',
    }))
    expect(r.action).toBe('allow')
    expect(r.rule_id).toBeNull()
  })

  it('an Edit call carrying the snake_case new_string variant (some hosts) is also seen', async () => {
    const p = makePipeline()
    const editCall = () => input('Edit', {
      file_path: 'src/config.ts',
      old_string: 'placeholder',
      new_string: `const AWS_KEY = '${SECRET}'`,
    })
    const first = await p.evaluate(editCall())
    expect(first.rule_id).toBe('no-secrets-in-code')
    const second = await p.evaluate(editCall())
    expect(second.action).toBe('deny')
    expect(second.rule_id).toBe('no-secrets-in-code')
  })
})
