import { describe, it, expect } from 'vitest'
import { normalizeCommand } from '../command-normalizer.js'

/**
 * Whitebox tests for command-normalizer.ts (M1/A2). The pipeline-level
 * corpus proving the shipped default rules actually catch these bypasses
 * through the normalized surface lives in shell-normalize-bypass.test.ts;
 * this file tests the module's mechanics in isolation.
 */

describe('intra-token quoting is stripped only when it changed nothing', () => {
  it('strips whitespace-free quoting (pure obfuscation)', () => {
    expect(normalizeCommand('r"m" -rf /').surfaces).toContain('rm -rf /')
    expect(normalizeCommand('keel di"s"able').surfaces).toContain('keel disable')
    expect(normalizeCommand('git push "--force"').surfaces).toContain('git push --force')
    expect(normalizeCommand("git di'sable'").surfaces).toContain('git disable')
  })

  it('preserves quoting that carries whitespace (a real data argument, not obfuscation)', () => {
    // No additional surface beyond raw: the quoted span became a single
    // opaque argument in real shell semantics too, so stripping its quotes
    // would fuse "data that looks like a command" into something a regex
    // could mistake for one. This is the mechanism that keeps
    // `echo "rm -rf /"` from becoming a NEW false positive under
    // normalization (see shell-normalize-bypass.test.ts for the pipeline-
    // level proof, including the two cases that actually discriminate
    // this design: a quoted commit message containing `rm -rf .` or
    // `git push --force`).
    const n = normalizeCommand('echo "rm -rf /"')
    expect(n.surfaces).toEqual(['echo "rm -rf /"'])
  })
})

describe('compound-command splitting', () => {
  it('splits on ; && || | & and newline, quote-aware', () => {
    expect(normalizeCommand('x && rm -rf /').surfaces).toContain('rm -rf /')
    expect(normalizeCommand('x ; rm -rf /').surfaces).toContain('rm -rf /')
    expect(normalizeCommand('x || rm -rf /').surfaces).toContain('rm -rf /')
    expect(normalizeCommand('cat foo | rm -rf /').surfaces).toContain('rm -rf /')
    expect(normalizeCommand('x & rm -rf /').surfaces).toContain('rm -rf /')
    expect(normalizeCommand('x\nrm -rf /').surfaces).toContain('rm -rf /')
  })

  it('does not split on a separator character sitting inside quotes', () => {
    const n = normalizeCommand('echo "a; b && c"')
    expect(n.subcommands.length).toBe(1)
    expect(n.surfaces).toEqual(['echo "a; b && c"'])
  })

  it('rejoins the full normalized string using the ORIGINAL separators, not bare spaces', () => {
    // A shipped pattern like `rm[^|;&]*--no-preserve-root` relies on `;`
    // still being present between what were independently-matched
    // sub-commands — joining with a bare space would let that guard cross
    // a boundary it was written to stop at.
    const n = normalizeCommand('rm -rf x ; echo --no-preserve-root')
    expect(n.normalized).toContain(';')
  })
})

describe('bounded variable expansion', () => {
  it('expands a literal inline assignment seen earlier in the SAME string', () => {
    const n = normalizeCommand('T=/; rm -rf $T')
    expect(n.surfaces).toContain('rm -rf /')
  })

  it('expands ${VAR} braced form', () => {
    const n = normalizeCommand('T=/; rm -rf ${T}')
    expect(n.surfaces).toContain('rm -rf /')
  })

  it('leaves an unresolved variable name as-is (no real env access, by design)', () => {
    const n = normalizeCommand('rm -rf $UNSET_VAR')
    expect(n.surfaces.some(s => s.includes('$UNSET_VAR'))).toBe(true)
  })

  it('does not expand inside a single-quoted span (documented conservative limitation)', () => {
    const n = normalizeCommand("T=/; echo '$T'")
    // The quoted span has no whitespace, so its quotes ARE stripped for
    // the surface — but expansion is skipped because it came from a
    // quoted segment, so the literal text `$T` survives unexpanded.
    expect(n.surfaces.some(s => s.includes('$T'))).toBe(true)
    expect(n.surfaces.some(s => s.includes('echo /'))).toBe(false)
  })

  it('strips a leading env-assignment prefix so the command starts at the real argv0', () => {
    const n = normalizeCommand('FOO=1 rm -rf ~')
    const sub = n.subcommands[0]
    expect(sub.envAssignments).toEqual({ FOO: '1' })
    expect(sub.normalizedCommand).toBe('rm -rf ~')
  })
})

describe('interpreter body extraction and recursion', () => {
  it('exposes a python -c body as an additional flat-text surface', () => {
    const n = normalizeCommand(`python3 -c "import shutil; shutil.rmtree('/')"`)
    expect(n.surfaces).toContain(`import shutil; shutil.rmtree('/')`)
  })

  it('exposes a node -e body', () => {
    const n = normalizeCommand(`node -e "require('fs').rmSync('/', {recursive:true})"`)
    expect(n.surfaces).toContain(`require('fs').rmSync('/', {recursive:true})`)
  })

  it('recurses one level into sh -c and re-normalizes the inner command (catches an obfuscated inner payload)', () => {
    const n = normalizeCommand(`sh -c 'r"m" -rf /'`)
    expect(n.surfaces).toContain('rm -rf /')
  })

  it('caps interpreter recursion at depth 1: a sh -c body that itself contains another sh -c is not re-normalized a second time', () => {
    const n = normalizeCommand(`sh -c 'sh -c "r\\"m\\" -rf /"'`)
    // The depth-1 nested call sees the inner `sh -c "r\"m\" -rf /"` as its
    // own subcommand text and WOULD normalize its quoting if it recursed
    // again, but MAX_INTERPRETER_DEPTH stops it — the depth-1 surfaces
    // still contain the raw (unstripped) inner text, just not a
    // depth-2-normalized `rm -rf /`.
    expect(n.surfaces.some(s => s === 'rm -rf /')).toBe(false)
  })
})

describe('sprint-2 fixes: five bugs found via live reproduction during the audit', () => {
  it('fix 1: a trailing/lone unescaped backslash does not hang tokenize() (was an infinite loop / OOM crash)', () => {
    // Reproduced pre-fix: both calls made zero progress in tokenize()'s
    // plain-run loop and spun forever. `cd C:\` is an ORDINARY Windows path,
    // not an adversarial payload.
    expect(() => normalizeCommand('echo hi\\')).not.toThrow()
    expect(normalizeCommand('echo hi\\').surfaces).toEqual(['echo hi\\'])
    expect(() => normalizeCommand('cd C:\\')).not.toThrow()
    expect(normalizeCommand('cd C:\\').surfaces).toEqual(['cd C:\\'])
  })

  it('fix 2: `-c --` is real bash/sh end-of-options — the body is the token AFTER `--`, not `--` itself', () => {
    const bash = normalizeCommand("bash -c -- 'rm -rf /'")
    expect(bash.surfaces).toContain('rm -rf /')
    const sh = normalizeCommand("sh -c -- 'rm -rf /'")
    expect(sh.surfaces).toContain('rm -rf /')
  })

  it('fix 3: an unquoted backslash-escaped space does not fuse into a fake word boundary on the joined surface', () => {
    // `mv rm\ -rf\ / backup/` moves a file literally named "rm -rf /" — a
    // single-argument benign command. Pre-fix this rendered as
    // `mv rm -rf / backup/`, indistinguishable from the real destructive
    // command on the regex-matching surface.
    const n = normalizeCommand('mv rm\\ -rf\\ / backup/')
    expect(n.surfaces.some(s => s === 'mv rm -rf / backup/')).toBe(false)
    expect(n.surfaces).toContain('mv rm\\ -rf\\ / backup/')
  })

  it('fix 4: SHELL_INTERPRETERS covers fish, csh, tcsh, ash (busybox) in addition to sh/bash/dash/zsh/ksh', () => {
    // Control: bash -c already surfaces the body.
    expect(normalizeCommand("bash -c 'rm -rf /'").surfaces).toContain('rm -rf /')
    expect(normalizeCommand("fish -c 'rm -rf /'").surfaces).toContain('rm -rf /')
    expect(normalizeCommand("tcsh -c 'rm -rf /'").surfaces).toContain('rm -rf /')
    expect(normalizeCommand("csh -c 'rm -rf /'").surfaces).toContain('rm -rf /')
    expect(normalizeCommand("ash -c 'rm -rf /'").surfaces).toContain('rm -rf /')
  })

  it('fix 5: a bare interpreter followed by a heredoc exposes the body as a surface (root cause of the self-protection bypass)', () => {
    const bash = normalizeCommand("bash <<'EOF'\necho hi\nrm -rf /\nEOF")
    // The heredoc body is exposed, AND (since bash is a shell) recursed one
    // level so its own lines become surfaces too — same mechanism as `sh -c`.
    expect(bash.surfaces).toContain('echo hi\nrm -rf /')
    expect(bash.surfaces).toContain('rm -rf /')

    const python = normalizeCommand(
      `python3 <<'PYEOF'\nopen('.keel/rules.yaml', 'w').write('pwned')\nPYEOF`,
    )
    expect(python.surfaces).toContain(`open('.keel/rules.yaml', 'w').write('pwned')`)
  })
})

describe('perf caps', () => {
  it('degrades to raw-only above the input-length cap instead of scanning an unbounded string', () => {
    const huge = 'echo ' + 'a'.repeat(5000)
    const n = normalizeCommand(huge)
    expect(n.truncated).toBe(true)
    expect(n.surfaces).toEqual([huge])
  })

  it('never throws on malformed/adversarial input', () => {
    const inputs = [
      'echo "unterminated',
      "echo 'unterminated",
      'a'.repeat(10),
      ';;;;&&&&||||',
      '$' + '{'.repeat(50),
      Array(200).fill('a;').join(''),
    ]
    for (const raw of inputs) {
      expect(() => normalizeCommand(raw)).not.toThrow()
    }
  })

  it('stays fast on a worst-case adversarial command (many subcommands, near the length cap, nested interpreter)', () => {
    const many = Array(60).fill('echo a').join(' ; ') + `; sh -c 'r"m" -rf /'`
    const start = process.hrtime.bigint()
    for (let i = 0; i < 200; i++) normalizeCommand(many)
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    const perCallMs = elapsedMs / 200
    // The pipeline's tier-2/3 budget is documented as ~0.01ms per rule
    // check; this normalizer runs ONCE per evaluate() call (memoized), so
    // budget it generously against the tier's overall <50ms target while
    // still catching a real regression.
    expect(perCallMs).toBeLessThan(5)
  })
})
