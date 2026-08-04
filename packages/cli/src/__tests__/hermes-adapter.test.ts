import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Hermes adapter is Python, so it is exercised through python3 rather
 * than imported. These checks are deliberately daemon-free and therefore
 * deterministic: they cover the verdict mapping and the offline circuit
 * breaker, which is where the adapter can be wrong in a way that is
 * silent. Live daemon behaviour is verified separately by hand, because a
 * test that starts a server is a test that flakes.
 */

const PLUGIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'templates', 'hermes', 'keel_plugin.py',
)

function python(script: string): string {
  return execFileSync('python3', ['-c', script], { encoding: 'utf-8', timeout: 30000 }).trim()
}

const LOAD = `
import importlib.util
spec = importlib.util.spec_from_file_location('kp', ${JSON.stringify(PLUGIN)})
kp = importlib.util.module_from_spec(spec); spec.loader.exec_module(kp)
`

describe('hermes adapter', () => {
  it('ships a syntactically valid plugin and manifest', () => {
    expect(existsSync(PLUGIN)).toBe(true)
    expect(existsSync(join(dirname(PLUGIN), 'plugin.yaml'))).toBe(true)
    // A syntax error here would only surface inside a user's Hermes.
    execFileSync('python3', ['-m', 'py_compile', PLUGIN], { timeout: 30000 })
  })

  it('maps every keel action to the right Hermes verdict', () => {
    const out = python(`${LOAD}
for a in ['deny','block','prompt','research','redirect','allow','warn','report','fix','mask']:
    v = kp.translate({'action': a, 'message': 'm', 'rule_id': 'r'}, emit=lambda t: None)
    print(a, '->', 'None' if v is None else v['action'])
`)
    const map = Object.fromEntries(out.split('\n').map(l => {
      const [action, , verdict] = l.split(' ')
      return [action, verdict]
    }))
    expect(map.deny).toBe('block')
    expect(map.block).toBe('block')
    expect(map.prompt).toBe('approve')
    expect(map.research).toBe('approve')
    expect(map.redirect).toBe('approve')
    // Advisory verdicts must never interrupt the agent.
    for (const advisory of ['allow', 'warn', 'report', 'fix', 'mask']) {
      expect(map[advisory]).toBe('None')
    }
  })

  it('surfaces a warning to the human even though it does not interrupt', () => {
    // keel's ladder is warn-once-then-block, so the FIRST violation of
    // every deny rule arrives as `warn`. Dropping it silently would mean
    // the user sees nothing, then a hard block on the repeat.
    const out = python(`${LOAD}
seen = []
kp.translate({'action':'warn','message':'first violation','rule_id':'no-destructive-commands'}, emit=seen.append)
kp.translate({'action':'allow','message':'Allowed (no matching rule)','rule_id':None}, emit=seen.append)
print(len(seen), '|', seen[0] if seen else '')
`)
    const [count, text] = out.split(' | ')
    expect(count).toBe('1')                                  // warn surfaced, allow silent
    expect(text).toContain('no-destructive-commands')
  })

  it('blocks only catastrophic commands when the daemon is unreachable', () => {
    const out = python(`${LOAD}
kp.TOKEN_PATH = '/nonexistent/no-token'
import io, contextlib
def verdict(cmd):
    with contextlib.redirect_stdout(io.StringIO()):
        v = kp.pre_tool_call(tool_name='bash', args={'command': cmd}, task_id='t')
    return 'None' if v is None else v['action']
for c in ['rm -rf /', 'rm -rf ~', 'git push --force origin main', 'DROP TABLE users;',
          'ls -la', 'npm test', 'rm -rf node_modules', 'git push origin feature/x']:
    print(verdict(c))
`).split('\n')
    // Catastrophic and irreversible → blocked even with no daemon.
    expect(out.slice(0, 4)).toEqual(['block', 'block', 'block', 'block'])
    // Ordinary work must still run. "Blocks everything when the daemon is
    // down" is the failure mode that gets a guardrail uninstalled, and
    // node_modules cleanup / feature-branch pushes are the classic
    // false positives of a naive deny list.
    expect(out.slice(4)).toEqual(['None', 'None', 'None', 'None'])
  })

  it('says loudly that enforcement is degraded when the daemon is down', () => {
    const out = python(`${LOAD}
kp.TOKEN_PATH = '/nonexistent/no-token'
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    kp.pre_tool_call(tool_name='bash', args={'command':'ls'}, task_id='t')
print(buf.getvalue().strip())
`)
    expect(out).toContain('DEGRADED')
    expect(out).toContain('keel daemon')      // tells the user how to fix it
  })
})
