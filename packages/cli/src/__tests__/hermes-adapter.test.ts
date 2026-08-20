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

// PYTHONDONTWRITEBYTECODE keeps normal `import`-driven python3 calls below
// (the LOAD script, via importlib) from leaving a __pycache__/*.pyc
// artifact next to the shipped plugin source — which would otherwise leak
// into the published npm tarball, since npm's `files` field includes that
// whole directory verbatim and ignore-file filtering does not apply to
// explicitly-listed directories. Confirmed by reproduction via a real
// `npm publish --dry-run`; see session/v1/EVIDENCE/m5-release.md. Note
// this env var does NOT cover the explicit `py_compile` check below —
// py_compile.compile()'s whole job is to write a .pyc, so it deliberately
// ignores sys.dont_write_bytecode/this env var; that check redirects its
// output file explicitly instead (see below).
const PYTHON_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }

function python(script: string): string {
  return execFileSync('python3', ['-c', script], { encoding: 'utf-8', timeout: 30000, env: PYTHON_ENV }).trim()
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
    // Explicit cfile= redirects the compiled output to a throwaway temp
    // path — `python3 -m py_compile <file>` has no such flag and always
    // writes __pycache__/*.pyc next to the source, which would otherwise
    // leak into the published npm tarball (see PYTHON_ENV's comment
    // above). doraise=True keeps this raising on a real syntax error,
    // same as the CLI form's non-zero exit did.
    execFileSync('python3', ['-c', `
import py_compile, tempfile, os
cfile = os.path.join(tempfile.mkdtemp(), 'keel_plugin.pyc')
py_compile.compile(${JSON.stringify(PLUGIN)}, cfile=cfile, doraise=True)
`], { timeout: 30000, env: PYTHON_ENV })
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
          'TRUNCATE TABLE accounts;', ':(){ :|:& };:', 'mkfs.ext4 /dev/sda1',
          'dd if=/dev/zero of=/dev/sda bs=1M',
          'ls -la', 'npm test', 'rm -rf node_modules', 'git push origin feature/x',
          'dd if=file.img of=/dev/null']:
    print(verdict(c))
`).split('\n')
    // Catastrophic and irreversible → blocked even with no daemon. Covers
    // every OFFLINE_DENY category in keel_plugin.py: rm -rf of a root/home
    // path, force-push to a protected branch, destructive SQL (DROP and
    // TRUNCATE), a fork bomb, a filesystem format, and a raw write to a
    // block device.
    expect(out.slice(0, 8)).toEqual(['block', 'block', 'block', 'block', 'block', 'block', 'block', 'block'])
    // Ordinary work must still run. "Blocks everything when the daemon is
    // down" is the failure mode that gets a guardrail uninstalled:
    // node_modules cleanup, feature-branch pushes, and a `dd` writing TO a
    // regular file (only device targets are catastrophic) are the classic
    // false positives of a naive deny list.
    expect(out.slice(8)).toEqual(['None', 'None', 'None', 'None', 'None'])
  })

  it('documents a known false positive of the offline regex backstop: SQL keywords inside an unrelated string', () => {
    // OFFLINE_DENY is a regex backstop, not a second rule engine (see its
    // module comment) — it has no command-vs-string-literal distinction,
    // same class of imprecision as the real rule engine's own command-type
    // rules. This is not a bug to fix here; it is the accepted cost of
    // "block only what is catastrophic" being implemented as substring
    // matching. Recorded explicitly so a future tightening of the regex
    // doesn't silently change this without a test noticing either way.
    const out = python(`${LOAD}
kp.TOKEN_PATH = '/nonexistent/no-token'
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    v = kp.pre_tool_call(tool_name='bash', args={'command': 'echo "please DROP TABLE from your vocabulary"'}, task_id='t')
print('None' if v is None else v['action'])
`)
    expect(out).toBe('block')
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
