import { readFileSync } from 'node:fs'
import { extname, basename, dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Single-file syntax verification — the cheap half of post-edit checking.
 *
 * This lives in its own module because two callers need it and they must
 * not drag each other along: `PolicyEngine.autoVerify` (the `keel check`
 * path) and the OpenCode plugin's after-hook, which bundles core and
 * should not pull in the whole PolicyEngine class to run a parser.
 *
 * Two properties are load-bearing and must not regress:
 *
 * 1. **No shell.** Every external checker runs through `execFileSync` with
 *    an argv array. An earlier version interpolated the path into a shell
 *    string (`python3 -m py_compile "${filePath}"`), so a filename
 *    containing a quote or `$(...)` executed arbitrary commands — inside
 *    the tool whose job is preventing exactly that. Checkers that need no
 *    subprocess at all (TypeScript, JSON, YAML) run in-process.
 * 2. **"Cannot verify" is not "broken."** A missing interpreter returns
 *    null, never an error. A machine without python3 must not flag every
 *    .py file, or the checker becomes noise and gets switched off.
 *
 * Deliberately syntax-only. Catching invented imports and hallucinated
 * symbols needs whole-project type resolution, which costs seconds and
 * belongs at a commit boundary — not after every edit.
 */

/** The slice of the TypeScript API used for parsing. Structural, so keel
 *  never takes a runtime dependency on the compiler. */
interface TypeScriptParser {
  ScriptTarget: { Latest: number }
  ScriptKind: { TS: number; TSX: number }
  createSourceFile(name: string, text: string, target: number, setParents: boolean, kind: number): unknown
  flattenDiagnosticMessageText(text: unknown, separator: string): string
}

/**
 * Prefer the checked project's own TypeScript, so a file is parsed by the
 * version it is written against. keel lists typescript as a devDependency
 * only — when neither the project nor a local install provides one, the
 * caller reports "cannot verify" rather than a false syntax error.
 */
async function loadTypeScriptFor(filePath: string): Promise<TypeScriptParser | null> {
  const { createRequire } = await import('node:module')
  // Resolution is deliberately done through createRequire, never through
  // `await import('typescript')`: a static import specifier makes esbuild
  // inline the whole compiler into the OpenCode plugin bundle, which took
  // it from 293 KB to 9.8 MB. createRequire keeps it a runtime lookup, so
  // the compiler is borrowed if present and absent otherwise.
  for (const root of [join(dirname(filePath), 'noop.js'), import.meta.url]) {
    try {
      const ts = createRequire(root)('typescript')
      // A CommonJS require may hand back either the namespace or a
      // default-wrapped module depending on interop.
      const api = (ts?.createSourceFile ? ts : ts?.default) as TypeScriptParser | undefined
      if (api?.createSourceFile) return api
    } catch { /* try the next root */ }
  }
  return null
}

/**
 * @returns a one-line description of the syntax error, or null when the
 *          file is fine OR no verifier is available for it.
 */
export async function verifyFileSyntax(filePath: string): Promise<string | null> {
  const { execFileSync } = await import('node:child_process')
  const ext = extname(filePath).toLowerCase()
  const spawn = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { stdio: 'pipe', timeout: 10000 })

  try {
    switch (ext) {
      case '.py':
        spawn('python3', ['-m', 'py_compile', filePath])
        break
      case '.sh':
      case '.bash':
        spawn('bash', ['-n', filePath])
        break
      case '.js':
      case '.mjs':
      case '.cjs':
        spawn(process.execPath, ['--check', filePath])
        break
      case '.ts':
      case '.tsx':
      case '.mts':
      case '.cts': {
        // TypeScript previously fell through to `default` — silently
        // unverified, the worst outcome for a checker, because the user
        // believes edits are checked when they are not.
        const ts = await loadTypeScriptFor(filePath)
        if (!ts) return null
        const source = readFileSync(filePath, 'utf-8')
        const kind = ext === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        const parsed = ts.createSourceFile(basename(filePath), source, ts.ScriptTarget.Latest, false, kind)
        const diagnostics = (parsed as { parseDiagnostics?: Array<{ messageText: unknown }> }).parseDiagnostics
        if (diagnostics?.length) {
          return ts.flattenDiagnosticMessageText(diagnostics[0].messageText, ' ')
        }
        break
      }
      case '.json':
        JSON.parse(readFileSync(filePath, 'utf-8'))
        break
      case '.yaml':
      case '.yml':
        // Directly relevant to this tool: a malformed .keel.yaml fails
        // closed, so catching it at edit time beats discovering it when
        // every action suddenly starts being denied.
        parseYaml(readFileSync(filePath, 'utf-8'))
        break
      default:
        return null
    }
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code
    // ENOENT from the interpreter itself is "no verifier available" —
    // distinct from "the file is broken", and must not be reported as one.
    if (code === 'ENOENT' || code === 'EACCES') return null
    return String((err as { message?: string })?.message || '').split('\n')[0]
  }
  return null
}

/** Extensions `verifyFileSyntax` can actually check — lets a caller skip
 *  the work entirely rather than calling and discarding a null. */
const VERIFIABLE = new Set([
  '.py', '.sh', '.bash', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.mts', '.cts', '.json', '.yaml', '.yml',
])

export function isVerifiableFile(filePath: string): boolean {
  return VERIFIABLE.has(extname(filePath).toLowerCase())
}
