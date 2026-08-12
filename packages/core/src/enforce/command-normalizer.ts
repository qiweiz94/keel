/**
 * Bounded shell-normalization layer (M1/A2).
 *
 * Command rules match a regex against the RAW command string
 * (`commandString()` in arg-utils.ts). Three of the red-team's four
 * documented evasion classes (SECURITY.md "Four classes of evasion that no
 * regex rule closes") survive purely because the raw string still LOOKS
 * obfuscated to a regex: `r"m" -rf /` never contains the literal substring
 * "rm", `T=/; rm -rf $T` never contains "rm -rf /", and `x && rm -rf /` is
 * one un-split blob a rule anchored to a command start cannot parse.
 *
 * This module does NOT execute anything and does NOT resolve the agent's
 * real process environment. It is a best-effort, bounded, purely-textual
 * rewrite that makes those three classes visible to the EXISTING regexes,
 * plus exposes interpreter one-liner bodies (`python3 -c "..."`,
 * `sh -c "..."`) as an additional surface. What it deliberately does NOT
 * attempt is documented inline at each limit below and summarized in
 * SECURITY.md.
 *
 * ── Design summary ──
 *
 * 1. Tokenizer: a hand-rolled POSIX-ish word-splitter (no dependency — see
 *    packages/core/package.json, this repo carries zero shell-parsing
 *    libs and the task calls for zero-new-deps). It tracks quotes well
 *    enough to know word boundaries and to tell "this quoting changed
 *    nothing" (`r"m"`, `"--force"` — no whitespace inside the quoted run)
 *    apart from "this quoting changed word-splitting" (`"rm -rf /"` as a
 *    single argument to `echo` — whitespace inside the quoted run). Only
 *    the former gets its quotes stripped for the regex-matching surface;
 *    the latter is preserved VERBATIM, quotes and all. That one rule is
 *    the entire mechanism behind not turning `echo "rm -rf /"` into a
 *    worse false positive than it already is (see the module-level note
 *    on `normalizeCommand` below — that specific command already denies
 *    on the RAW string today, before this module exists, because the
 *    shipped `no-destructive-commands` pattern has no trailing anchor
 *    after the path alternatives it's hunting for; this module is not
 *    what causes that, and per the additive constraint it is not this
 *    module's job to un-catch it either).
 *
 * 2. Compound-command splitting: `;`, `&&`, `||`, single `&`, `|`, and
 *    newlines split the raw string into independently-matched
 *    sub-commands, quote-aware (a `;` inside a quoted string is not a
 *    boundary). This is what lets an anchored/prefix rule see `rm -rf /`
 *    as the START of its own sub-command in `x && rm -rf /`, not buried
 *    mid-string.
 *
 * 3. Variable expansion is INTENTIONALLY tiny: a single left-to-right pass
 *    over `NAME=value` assignments that appear as their own sub-command or
 *    as a leading prefix on a sub-command, IN THE SAME raw string, applied
 *    only inside unquoted token segments. It cannot and does not attempt
 *    to resolve the agent's real environment, command substitution
 *    (`$(...)`), backticks, arithmetic expansion, or a variable assigned
 *    in a PRIOR shell call this module never saw. `T=/; rm -rf $T` is
 *    exactly the shape this closes and exactly the limit of what it
 *    closes. One exception: the dict is seeded with a single hardcoded
 *    literal, `IFS: ' '` (`BUILTIN_VAR_DEFAULTS` below) — IFS is a shell
 *    BUILT-IN that controls word-splitting itself (POSIX default: space,
 *    tab, newline; a single space is the correct normalization for
 *    re-joining split tokens), never something the command being
 *    evaluated assigns before using it, so `rm${IFS}-rf${IFS}/` is a
 *    real evasion this module can and should close without becoming real
 *    environment access. It is still just a dict entry: an explicit
 *    in-command `IFS=x; ...` overrides it exactly like any other
 *    `NAME=value` assignment.
 *
 * 4. Interpreter bodies: `python(2/3)? -c`, `node -e`/`--eval`,
 *    `perl -e/-E/-p`, and `sh|bash|dash|zsh|ksh -c` have their quoted
 *    argument extracted as a decoded (quotes-stripped-regardless-of-
 *    whitespace) logical value and exposed as an ADDITIONAL surface. This
 *    is the one deliberate exception to rule (1)'s "don't strip
 *    whitespace-bearing quotes" — it is safe specifically because the
 *    token position is positively identified as a known interpreter's
 *    code argument via an allowlist of (interpreter, flag) pairs, i.e. a
 *    COMMAND position, not a data argument to an arbitrary command like
 *    `echo`. A shell interpreter's body is additionally re-parsed by
 *    recursing into `normalizeCommand` ONE level deep (`depth` param,
 *    capped at 1); a non-shell interpreter's body (python/node/perl) is
 *    exposed as flat text only — it is not shell syntax and is not
 *    re-tokenized as such.
 *
 * ── What stays open (see SECURITY.md) ──
 *   - Command substitution / backticks / arithmetic expansion are not
 *     parsed; their text is left as literal characters in whatever token
 *     it's part of (not further split or resolved).
 *   - Subshell grouping `( ... )` is not tracked.
 *   - A variable's value from the REAL process environment (not visible
 *     to this module) or from a command run in a PRIOR turn is not
 *     resolvable — only literals assigned inline in the same string.
 *   - Symlink redirection is out of scope entirely (a runtime-fs concern,
 *     not a string-normalization one).
 *   - Interpreter recursion is capped at depth 1; a `sh -c` body that
 *     itself contains another `sh -c "..."` is not recursed a second
 *     time (its raw text is still present in the depth-1 surfaces, just
 *     not re-tokenized).
 */

/** Hard caps — this sits on the pipeline's <50ms hot path (evaluate() tier 2/3). */
const MAX_INPUT_LEN = 4000
const MAX_SUBCOMMANDS = 64
const MAX_TOKENS_PER_SUBCOMMAND = 256
const MAX_INTERPRETER_DEPTH = 1

const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh'])

type InterpreterKind = 'shell' | 'python' | 'node' | 'perl'

function classifyInterpreter(basename: string): InterpreterKind | null {
  if (SHELL_INTERPRETERS.has(basename)) return 'shell'
  if (/^python[0-9.]*$/.test(basename)) return 'python'
  if (basename === 'node' || basename === 'nodejs') return 'node'
  if (/^perl[0-9.]*$/.test(basename)) return 'perl'
  return null
}

function interpreterFlags(kind: InterpreterKind): string[] {
  switch (kind) {
    case 'shell': return ['-c']
    case 'python': return ['-c']
    case 'node': return ['-e', '--eval']
    case 'perl': return ['-e', '-E', '-p']
  }
}

function basename(path: string): string {
  // The command text this reads argv[0] from is shell-command text, not a
  // resolved filesystem path, so it is not run through path-normalize.ts's
  // canonicalizer — but a Windows-style invocation (`C:\Python\python.exe`,
  // a cmd.exe/PowerShell interpreter path) still uses `\`, so both
  // separators are split on here.
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

export interface NormalizedToken {
  /** Regex-matching surface for THIS token alone: quotes stripped only where the quoted run had no whitespace. */
  rendered: string
  /** Fully-decoded logical value (quotes always stripped) — what the shell would actually hand argv. Structured data; never fed to a regex-substring matcher on its own (see module doc). */
  value: string
}

export interface NormalizedSubcommand {
  raw: string
  tokens: NormalizedToken[]
  /** tokens[].rendered joined with single spaces — includes any leading env-assignment prefix. */
  normalized: string
  /** normalized with a detected leading env-assignment prefix stripped (empty if the whole sub-command WAS the assignment). */
  normalizedCommand: string
  envAssignments: Record<string, string>
  /** Decoded interpreter-code argument, when this sub-command's argv0 is a known interpreter with a code flag. */
  interpreterBody?: string
  /** One-level recursive re-normalization of interpreterBody, only when the interpreter is a shell (`-c`). */
  nested?: NormalizedCommand
}

export interface NormalizedCommand {
  raw: string
  /** Sub-command `normalized` strings rejoined with their ORIGINAL separators (`;`, `&&`, `||`, `|`, `&`, newline) — this is what keeps `[^|;&]*` guards in shipped patterns meaningful. */
  normalized: string
  subcommands: NormalizedSubcommand[]
  /** Every string worth testing a command regex against: raw, normalized (full + per-subcommand), and interpreter-body surfaces (own + nested), deduped. */
  surfaces: string[]
  /** True if an input-size/count cap was hit and normalization degraded toward raw-only. */
  truncated: boolean
}

interface Segment {
  text: string
  quoted: boolean
  hasSpace: boolean
  quoteChar: '"' | "'" | ''
}

interface Token {
  segments: Segment[]
}

/** Quote-aware char scan shared by tokenize() and splitTopLevel(): tracks whether `i` sits inside a quote. */
function isQuoteChar(c: string): c is '"' | "'" {
  return c === '"' || c === "'"
}

/**
 * Word-split ONE sub-command string. Handles single/double quotes and a
 * bare backslash (escapes the next char literally, outside quotes). Does
 * NOT recognize `$(...)`/backtick command substitution specially — see
 * module doc.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = text.length
  let current: Segment[] | null = null

  const pushSegment = (seg: Segment) => {
    if (!current) current = []
    current.push(seg)
  }
  const endToken = () => {
    if (current) {
      tokens.push({ segments: current })
      current = null
    }
  }

  while (i < n) {
    const c = text[i]
    if (c === ' ' || c === '\t') {
      endToken()
      i++
      continue
    }
    if (c === '\\' && i + 1 < n) {
      // Unquoted backslash escape: next char literal, strip the backslash.
      pushSegment({ text: text[i + 1], quoted: false, hasSpace: false, quoteChar: '' })
      i += 2
      continue
    }
    if (isQuoteChar(c)) {
      const quoteChar = c
      let j = i + 1
      let inner = ''
      while (j < n && text[j] !== quoteChar) {
        if (quoteChar === '"' && text[j] === '\\' && j + 1 < n && (text[j + 1] === '"' || text[j + 1] === '\\')) {
          inner += text[j + 1]
          j += 2
          continue
        }
        inner += text[j]
        j++
      }
      // Unterminated quote (malformed input): treat rest of string as inner — best-effort, never throw.
      const hasSpace = /[ \t]/.test(inner)
      pushSegment({ text: inner, quoted: true, hasSpace, quoteChar })
      i = j + 1
      continue
    }
    // Plain run: accumulate until whitespace, quote, or backslash.
    let j = i
    let buf = ''
    while (j < n && text[j] !== ' ' && text[j] !== '\t' && !isQuoteChar(text[j]) && text[j] !== '\\') {
      buf += text[j]
      j++
    }
    pushSegment({ text: buf, quoted: false, hasSpace: false, quoteChar: '' })
    i = j
  }
  endToken()
  if (tokens.length > MAX_TOKENS_PER_SUBCOMMAND) tokens.length = MAX_TOKENS_PER_SUBCOMMAND
  return tokens
}

/**
 * Known-default seed for `expandVars`'s dict — NOT real env access (see
 * module doc §3). IFS is the one shell built-in whose value this module
 * needs to know without ever seeing a prior assignment: it governs
 * word-splitting itself, so `${IFS}`/`$IFS` is used purely to re-join a
 * command's own tokens (`rm${IFS}-rf${IFS}/`), not to read anything about
 * the agent's environment. A single space is the shell's own POSIX
 * default for IFS and is sufficient for this purpose.
 */
const BUILTIN_VAR_DEFAULTS: Record<string, string> = { IFS: ' ' }

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

/** Bounded expansion: literal dict lookup only, unresolved names left as-is (documented — no real env access). */
function expandVars(text: string, dict: Record<string, string>): string {
  return text.replace(VAR_RE, (whole, braced, bare) => {
    const name = braced || bare
    return Object.prototype.hasOwnProperty.call(dict, name) ? dict[name] : whole
  })
}

const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/

function renderToken(token: Token, dict: Record<string, string>): NormalizedToken {
  let rendered = ''
  let value = ''
  for (const seg of token.segments) {
    if (seg.quoted && seg.hasSpace) {
      // Whitespace inside the quote: this is DATA, not obfuscation. Keep
      // the quotes verbatim in the regex-matching surface (this is the
      // mechanism that keeps `echo "rm -rf /"` from becoming a NEW false
      // positive under normalization — see module doc). No expansion,
      // matching real single-quote semantics and conservatively also
      // skipping double-quote expansion (documented limitation).
      rendered += seg.quoteChar + seg.text + seg.quoteChar
      value += seg.text
    } else if (seg.quoted) {
      // Whitespace-free quoting only ever obfuscates a token
      // (`r"m"` -> `rm`, `"--force"` -> `--force`); strip it.
      rendered += seg.text
      value += seg.text
    } else {
      const expanded = expandVars(seg.text, dict)
      rendered += expanded
      value += expanded
    }
  }
  return { rendered, value }
}

const SEPARATORS: Array<{ token: string; re: RegExp }> = [
  { token: '&&', re: /^&&/ },
  { token: '||', re: /^\|\|/ },
  { token: ';', re: /^;/ },
  { token: '|', re: /^\|/ },
  { token: '&', re: /^&/ },
  { token: '\n', re: /^\n/ },
]

/** Quote-aware split on `;`, `&&`, `||`, `|`, `&`, newline. Returns [subcommandText, separatorAfterIt][]. */
function splitTopLevel(raw: string): Array<{ text: string; sepAfter: string }> {
  const parts: Array<{ text: string; sepAfter: string }> = []
  let buf = ''
  let i = 0
  const n = raw.length
  let quote: '"' | "'" | null = null
  while (i < n) {
    const c = raw[i]
    if (quote) {
      buf += c
      if (c === quote && raw[i - 1] !== '\\') quote = null
      i++
      continue
    }
    if (isQuoteChar(c)) {
      quote = c
      buf += c
      i++
      continue
    }
    if (c === '\\' && i + 1 < n) {
      buf += c + raw[i + 1]
      i += 2
      continue
    }
    let matched: string | null = null
    for (const s of SEPARATORS) {
      if (s.re.test(raw.slice(i))) { matched = s.token; break }
    }
    if (matched) {
      parts.push({ text: buf, sepAfter: matched })
      buf = ''
      i += matched.length
      if (parts.length >= MAX_SUBCOMMANDS) break
      continue
    }
    buf += c
    i++
  }
  parts.push({ text: buf, sepAfter: '' })
  return parts
}

function normalizeSubcommand(rawSub: string, dict: Record<string, string>, depth: number): NormalizedSubcommand {
  const rawTrimmed = rawSub.trim()
  const rawTokens = tokenize(rawSub)
  const rendered = rawTokens.map(t => renderToken(t, dict))

  // Strip leading env-assignment prefix (recording into the shared dict as we go).
  let cut = 0
  const envAssignments: Record<string, string> = {}
  while (cut < rendered.length) {
    const m = ASSIGNMENT_RE.exec(rendered[cut].value)
    if (!m) break
    const [, name, valRaw] = m
    const val = expandVars(valRaw, dict)
    envAssignments[name] = val
    dict[name] = val
    cut++
  }
  // Re-render tokens AFTER the cut using the (possibly just-extended) dict,
  // so a same-subcommand prefix assignment (`T=/ rm -rf $T`, no `;`) resolves too.
  const commandTokens = rawTokens.slice(cut).map(t => renderToken(t, dict))

  const tokens: NormalizedToken[] = [...rendered.slice(0, cut), ...commandTokens]
  const normalized = tokens.map(t => t.rendered).join(' ')
  const normalizedCommand = commandTokens.map(t => t.rendered).join(' ')

  const sub: NormalizedSubcommand = {
    raw: rawTrimmed,
    tokens,
    normalized,
    normalizedCommand,
    envAssignments,
  }

  if (commandTokens.length > 0) {
    const argv0 = commandTokens[0].value
    const kind = classifyInterpreter(basename(argv0))
    if (kind) {
      const flags = interpreterFlags(kind)
      for (let k = 1; k < commandTokens.length - 1; k++) {
        const tok = commandTokens[k].value
        // A shell's `-c` code flag may arrive bundled with other short options
        // (`bash -lc`, `bash -ic`, `sh -xc`): `-c` must be the LAST letter of a
        // short-option cluster because it consumes the next argument as the
        // command. Match that cluster too so the body is still extracted as a
        // surface — closes the `bash -lc '...'` control-gate / destructive
        // bypass (M6 red-team round 2). Extraction only ADDS a surface to test,
        // never suppresses one, so an over-match is safe.
        const isCodeFlag = flags.includes(tok)
          || (kind === 'shell' && /^-[a-z]*c$/.test(tok))
        if (isCodeFlag) {
          const bodyToken = commandTokens[k + 1]
          sub.interpreterBody = bodyToken.value
          if (kind === 'shell' && depth < MAX_INTERPRETER_DEPTH) {
            sub.nested = normalizeCommand(bodyToken.value, depth + 1)
          }
          break
        }
      }
    }
  }

  return sub
}

/**
 * Normalize a raw shell command string into a bounded set of regex-matching
 * surfaces plus structured per-sub-command tokens. See module doc for the
 * exact mechanism and the honest limits. Never throws; degrades toward
 * `{ surfaces: [raw] }` on any cap trip or unexpected shape.
 */
export function normalizeCommand(raw: string, depth = 0): NormalizedCommand {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { raw: raw || '', normalized: raw || '', subcommands: [], surfaces: [raw || ''], truncated: false }
  }
  if (raw.length > MAX_INPUT_LEN) {
    return { raw, normalized: raw, subcommands: [], surfaces: [raw], truncated: true }
  }

  try {
    const parts = splitTopLevel(raw)
    const truncated = parts.length >= MAX_SUBCOMMANDS
    const dict: Record<string, string> = { ...BUILTIN_VAR_DEFAULTS }
    const subcommands = parts
      .filter(p => p.text.trim().length > 0)
      .map(p => normalizeSubcommand(p.text, dict, depth))

    // Rejoin using the ORIGINAL separators so `[^|;&]*` guards in shipped
    // patterns still see a boundary between what were independent
    // sub-commands (joining with a bare space would let such a guard
    // cross a subcommand boundary it was written to stop at).
    let normalizedFull = ''
    let si = 0
    for (const part of parts) {
      if (part.text.trim().length === 0) {
        normalizedFull += part.sepAfter
        continue
      }
      normalizedFull += subcommands[si].normalized + part.sepAfter
      si++
    }

    const surfaces: string[] = [raw]
    if (normalizedFull !== raw) surfaces.push(normalizedFull)
    for (const sub of subcommands) {
      if (sub.normalized && !surfaces.includes(sub.normalized)) surfaces.push(sub.normalized)
      if (sub.normalizedCommand && sub.normalizedCommand !== sub.normalized && !surfaces.includes(sub.normalizedCommand)) {
        surfaces.push(sub.normalizedCommand)
      }
      if (sub.interpreterBody && !surfaces.includes(sub.interpreterBody)) surfaces.push(sub.interpreterBody)
      if (sub.nested) {
        for (const s of sub.nested.surfaces) if (!surfaces.includes(s)) surfaces.push(s)
      }
    }

    return { raw, normalized: normalizedFull, subcommands, surfaces, truncated }
  } catch {
    return { raw, normalized: raw, subcommands: [], surfaces: [raw], truncated: true }
  }
}
