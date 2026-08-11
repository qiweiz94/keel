import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { validateRules } from '../rule-parser.js'
import { findRepoRoot } from './repo-root.js'

/**
 * Wave-2 Lane 5 (sequence + budget rules) proposals.
 *
 * session/proposals/test-before-commit.yaml and session/proposals/
 * runaway-budget.yaml are shipped as raw YAML rule lists (not full
 * DEFAULT_RULES_YAML documents) that the supervisor mechanically pastes
 * into packages/cli/src/commands/install.ts and plugin.ts's
 * DEFAULT_RULES_YAML at the Wave-2 gate. This test loads them exactly as
 * written on disk and runs them through the SAME `validateRules` the CLI
 * runs on every shipped rule, so a catalog-metadata typo (an invalid
 * `category`, an invalid `mode`, a bad regex, ...) is caught here, before
 * it reaches the gate's mechanical paste and silently breaks the build.
 *
 * `category: verification` on test-before-commit required adding
 * 'verification' to RuleCategory (types.ts) and validCategories
 * (rule-parser.ts) — see session/EVIDENCE/wave2-seq.md for why that is a
 * safe additive change (nothing in the codebase exhaustively switches over
 * RuleCategory).
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = findRepoRoot(HERE)
const PROPOSALS_DIR = join(REPO_ROOT, 'session', 'proposals')

function loadProposalRules(filename: string): unknown[] {
  const path = join(PROPOSALS_DIR, filename)
  const raw = readFileSync(path, 'utf-8')
  const parsed = parseYaml(raw)
  expect(Array.isArray(parsed), `${filename} must parse to a YAML list of rules`).toBe(true)
  return parsed as unknown[]
}

describe('proposal rule YAML validates cleanly (validateRules)', () => {
  it('test-before-commit.yaml has zero validation errors', () => {
    const rules = loadProposalRules('test-before-commit.yaml')
    expect(rules.length).toBe(1)
    const errors = validateRules(rules)
    expect(errors, `validation errors: ${JSON.stringify(errors)}`).toEqual([])
  })

  it('runaway-budget.yaml has zero validation errors', () => {
    const rules = loadProposalRules('runaway-budget.yaml')
    expect(rules.length).toBe(2)
    const errors = validateRules(rules)
    expect(errors, `validation errors: ${JSON.stringify(errors)}`).toEqual([])
  })

  it('both proposals declare mode: observe on every rule', () => {
    const rules = [...loadProposalRules('test-before-commit.yaml'), ...loadProposalRules('runaway-budget.yaml')] as Array<{ id: string; mode?: string }>
    for (const rule of rules) {
      expect(rule.mode, `rule "${rule.id}" is not mode: observe`).toBe('observe')
    }
  })
})
