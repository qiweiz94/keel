import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_RULES_YAML } from '../commands/install.js'

/**
 * `keel install` does not just read these files — it WRITES them into a
 * stranger's home directory, and the OpenCode plugin injects
 * ~/.keel/requirements.md into the system prompt on every single turn.
 *
 * So anything keel-project-specific in here is not a documentation wart;
 * it is keel reprogramming someone else's agent. A user who installs a
 * guardrail tool should not find their agent asserting that their product
 * is named "keel", or refusing to write CLAUDE.md because *this* repo
 * happens to use OpenCode.
 *
 * These assertions are deliberately about the shipped artifacts rather
 * than about ~/.keel/*, which is user-owned and must never be touched.
 */

const CLI_ROOT = join(__dirname, '..', '..')
const templatePath = (name: string) => join(CLI_ROOT, 'templates', name)

/** Strings that are meaningful to the keel repo and to nobody else. */
const KEEL_INTERNAL = [
  'ai-enforce',
  'OpenCode',
  'CLAUDE.md',
  'AGENTS.md',
  'Product name',
  'product identity',
]

const installSource = () =>
  readFileSync(join(CLI_ROOT, 'src', 'commands', 'install.ts'), 'utf-8')

describe('shipped requirements template', () => {
  const template = () => readFileSync(templatePath('requirements.md'), 'utf-8')

  it.each(KEEL_INTERNAL)('does not impose keel-internal context: %s', (needle) => {
    expect(template().toLowerCase()).not.toContain(needle.toLowerCase())
  })

  it('still carries the general requirements that make it worth shipping', () => {
    const text = template()
    // If we strip the repo-specific lines and leave an empty husk, the file
    // stops earning the system-prompt real estate it consumes every turn.
    expect(text).toMatch(/test/i)
    expect(text).toMatch(/evidence|proof/i)
    expect(text).toMatch(/root cause/i)
    expect(text.length).toBeGreaterThan(400)
  })
})

describe('inline fallback requirements in install.ts', () => {
  // findRequirementsSource() returns null when the templates dir is absent
  // (a global npm install that lost its files), and then this inline copy
  // is what lands in the user's home. It drifted from the template once
  // already; a template-only assertion would miss it entirely.
  it.each(KEEL_INTERNAL)('does not reintroduce keel-internal context: %s', (needle) => {
    const src = installSource()
    const start = src.indexOf('Prefer the canonical draft template')
    expect(start).toBeGreaterThan(-1)
    const fallback = src.slice(start, src.indexOf('writeFileSync(reqPath', start))
    expect(fallback.toLowerCase()).not.toContain(needle.toLowerCase())
  })
})

describe('default rules shipped to every user', () => {
  it('does not ship keel’s own product-naming history as a user rule', () => {
    // `product-name-is-keel` denied renaming keel→ai-enforce at priority
    // 100 in a stranger's repo — enforcing this project's rename decision
    // on people who have never heard of either name.
    expect(DEFAULT_RULES_YAML).not.toContain('product-name-is-keel')
    expect(DEFAULT_RULES_YAML).not.toContain('ai-enforce')
  })

  it('still ships the self-protection floors', () => {
    // The control gate is the opposite case: it protects the USER's
    // ownership of keel, so it must survive this cleanup.
    expect(DEFAULT_RULES_YAML).toContain('keel-control-gate')
    expect(DEFAULT_RULES_YAML).toContain('no-rules-tampering')
    expect(DEFAULT_RULES_YAML).toContain('no-enforcer-removal')
  })
})
