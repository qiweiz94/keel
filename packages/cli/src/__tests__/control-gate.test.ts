import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRulesContent } from '../core/enforce/rule-parser.js'

/**
 * `keel-control-gate` is the rule that keeps keel's control surface owned by
 * the human: an agent that can reconfigure the guardrail has no guardrail.
 *
 * It listed six subcommands by name, which means every NEW mutating
 * subcommand is un-gated by default — the gate does not fail safe. That is
 * how `keel rules harness --append` shipped able to edit ~/.keel/rules.yaml
 * with only a TTY check standing in the way, and a TTY check has a
 * documented environment-variable escape hatch used by the test suite.
 *
 * Defence in depth: the TTY check is the mechanism, this rule is the policy,
 * and neither should be the only thing between an agent and the rules file.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))

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

function controlGatePattern(): RegExp {
  const src = readFileSync(findPluginSource(HERE), 'utf-8')
  const m = src.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  if (!m) throw new Error('DEFAULT_RULES_YAML not found')
  const rules = parseRulesContent(m[1], 'default-rules').rules
  const gate = rules.find(r => r.id === 'keel-control-gate')
  if (!gate?.match) throw new Error('keel-control-gate has no match pattern')
  return new RegExp(gate.match)
}

describe('keel-control-gate', () => {
  const gated = [
    'keel disable',
    'keel allow no-force-push --once',
    'keel level sprint',
    'keel enforce --level=protect',
    'keel install --opencode',
    'keel uninstall',
    // Mutates ~/.keel/rules.yaml — the file the whole control surface rests on.
    'keel rules harness --append',
    // Mutates a rule's mode field in rules.yaml — same class as `keel level`.
    'keel promote no-repeat-loops',
  ]

  it.each(gated)('blocks: %s', (command) => {
    expect(controlGatePattern().test(command)).toBe(true)
  })

  const allowed = [
    // Read-only. An agent SHOULD be able to show the user these rules —
    // gating the print would just push people back to hand-copying YAML.
    'keel rules harness',
    'keel rules atr --lane enforce',
    'keel scan',
    'keel status',
    'keel audit --tail 20',
    'keel validate',
    'keel retrospective',
    // `keel run <agent-cmd>` is DELIBERATELY NOT gated, unlike the verbs
    // above: every one of those directly reconfigures/disarms enforcement
    // (turns it off, changes strictness, edits rules.yaml, clears a
    // lockdown). `keel run` starts something NEW — it doesn't touch any
    // existing control. An agent that wants an un-intercepted execution
    // channel already has one today via plain shell backgrounding
    // (`nohup cmd &`, `setsid cmd`, `disown`), which this gate cannot and
    // does not attempt to close; singling out `keel run` for that same
    // class of risk would not close the real gap while removing the one
    // channel that gives a human something to `keel halt --kill` — net
    // LESS operator visibility, not more. See run.ts's own header and this
    // change's report for the fuller reasoning.
    'keel run claude',
    'keel run -- claude --dangerously-skip-permissions',
  ]

  it.each(allowed)('does not block read-only: %s', (command) => {
    expect(controlGatePattern().test(command)).toBe(false)
  })

  it('still blocks a gated verb embedded literally inside an UNQUOTED keel run payload (unanchored substring match, no unwrap needed)', () => {
    expect(controlGatePattern().test('keel run keel halt --kill')).toBe(true)
    expect(controlGatePattern().test('keel run "keel halt --kill"')).toBe(true)
  })

  it('a QUOTED embedded verb immediately followed by the closing quote needs the command-normalizer unwrap (raw substring alone misses it — the boundary after "disable" is a quote char, not whitespace/end-of-string)', async () => {
    const raw = 'keel run "keel disable"'
    // The raw string alone does NOT match — this is exactly the gap
    // command-normalizer.ts's `keel run` unwrap exists to close (see its
    // own module doc, section 4b): commandSurfaces() never evaluates a
    // command-type rule against the raw string alone.
    expect(controlGatePattern().test(raw)).toBe(false)

    const { normalizeCommand } = await import('../core/enforce/command-normalizer.js')
    const surfaces = normalizeCommand(raw).surfaces
    expect(surfaces).toContain('keel disable') // unwrapped, unquoted — now matches
    expect(surfaces.some(s => controlGatePattern().test(s))).toBe(true)
  })
})
