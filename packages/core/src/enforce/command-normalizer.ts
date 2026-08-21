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
 * 4b. `keel run <agent-cmd...>` (packages/cli/src/commands/run.ts) is
 *    handled the same way as rule (4)'s shell `-c` bodies: everything
 *    after `run` (skipping a literal `--`, if present) is extracted as
 *    `interpreterBody` and re-parsed one level deep. There is no
 *    single-flag trigger here — `argv0` basename `keel` immediately
 *    followed by the literal token `run` is the whole detection — but the
 *    reason is the same one-liner as (4)'s: without this, `keel run "rm
 *    -rf /"` presents every command-type rule with the wrapper text only,
 *    never the payload about to execute, which is a total bypass of the
 *    default ruleset, not a narrow gap.
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

// `fish`, `csh`, `tcsh` are real interactive/scripting shells with a `-c`
// flag; `ash` is busybox's shell (default `/bin/sh` on Alpine-based agent
// sandboxes) and also has `-c`. All four were reachable via `<shell> -c
// 'rm -rf /'` and ALLOWED before this set covered them (control: `bash -c`
// correctly denied). Known remaining gap, NOT fixed here: `busybox sh` /
// `busybox ash` invoked as `busybox sh -c '...'` has argv0 `busybox`, not
// the shell name — classifying that needs argv0-aware dispatch on busybox's
// own applet-selection argv[1], a harder, separate fix.
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'csh', 'tcsh', 'ash'])

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
  /** This segment is a de-escaped space/tab from an UNQUOTED `\ ` — data inside the token, not a token boundary. See renderToken. */
  escapedSpace?: boolean
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
      const next = text[i + 1]
      pushSegment({
        text: next,
        quoted: false,
        hasSpace: false,
        quoteChar: '',
        escapedSpace: next === ' ' || next === '\t',
      })
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
    if (j === i) {
      // Zero progress: the only way to land here is `text[i] === '\\'` with
      // `i` the LAST character in the string (the escape branch above
      // requires a following character and didn't fire). Treat a lone /
      // trailing backslash as a literal character so `i` always advances —
      // without this, `normalizeCommand('echo hi\\')` and
      // `normalizeCommand('cd C:\\')` (an ORDINARY Windows path, `cd C:\`)
      // spin forever making zero progress and OOM-crash the process.
      buf = text[j]
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
    } else if (seg.escapedSpace) {
      // A backslash-escaped space/tab is DATA inside this token, not a word
      // boundary — but normalizeSubcommand joins tokens' `rendered` with a
      // bare space, so re-emitting it as a literal space here would make a
      // single argument indistinguishable from a real word boundary on the
      // joined surface (`mv rm\ -rf\ / backup/`, a benign single-argument
      // command moving a file literally named "rm -rf /", would render as
      // `mv rm -rf / backup/` and false-positive-deny). Keep the backslash
      // in the rendered surface so it stays distinguishable; `value` (the
      // decoded logical argv value) still gets the real character.
      rendered += '\\' + seg.text
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
    if (basename(argv0) === 'keel' && commandTokens[1]?.value === 'run') {
      // `keel run <agent-cmd...>` wraps an ENTIRE command the same way
      // `bash -c` wraps a single string, except there is no `-c`-style flag
      // introducing the body — it is just "every token after `run`"
      // (optionally after a literal `--`, which `keel run`'s own commander
      // registration accepts to stop ITS OWN option parsing before the
      // wrapped command's flags — see index.ts). Unwrapping this the same
      // way `bash -lc` is unwrapped above closes what would otherwise be a
      // TOTAL bypass of every command-type rule in the default ruleset
      // (destructive commands, force-push, secrets, exfil,
      // keel-control-gate itself, ...): every one of those rules matches
      // against the raw command TEXT via `commandSurfaces()`
      // (arg-utils.ts), and `keel run "rm -rf /"` would otherwise present
      // the rule engine with only the wrapper text, never the payload
      // actually about to execute.
      let bodyIndex = 2
      if (commandTokens[bodyIndex]?.value === '--') bodyIndex++
      const bodyTokens = commandTokens.slice(bodyIndex)
      if (bodyTokens.length > 0) {
        // A single-token body (`keel run "rm -rf /"`) is exactly the shell
        // `-c 'body'` shape one level up — use the DECODED value directly,
        // same as the shell-body extraction just below, so a whitespace-
        // bearing quoted body surfaces unquoted.
        //
        // A multi-token body (`keel run bash -c "rm -rf /"`) is a real argv,
        // not one string — joining DECODED values with bare spaces would
        // destroy the original quoting (`"rm -rf /"`, one argument, would
        // become indistinguishable from three separate arguments `rm`,
        // `-rf`, `/`, corrupting the recursive re-parse below: a `bash -c`
        // wrapped one level in would see its OWN `-c` consume only the next
        // bare word instead of the real multi-word body). Joining RENDERED
        // forms instead reconstructs a string that reproduces the original
        // quote structure, so the recursive `normalizeCommand` call below
        // re-tokenizes it back into the same logical tokens.
        const bodyValue = bodyTokens.length === 1
          ? bodyTokens[0].value
          : bodyTokens.map(t => t.rendered).join(' ')
        sub.interpreterBody = bodyValue
        if (depth < MAX_INTERPRETER_DEPTH) {
          sub.nested = normalizeCommand(bodyValue, depth + 1)
        }
      }
    } else if (kind) {
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
          // `bash -c -- 'payload'` / `sh -c -- 'payload'`: real bash/sh
          // treat a literal `--` immediately after `-c` as end-of-options
          // and use the NEXT token as the body, not `--` itself. Without
          // this, the body extracted below is the literal string `--` and
          // the real payload never becomes a surface (M-audit: `bash -c --
          // 'rm -rf /'` never surfaced and allowed). Shell-specific: this
          // getopt convention applies to `-c`, not to python/node/perl's
          // code flags.
          let bodyIndex = k + 1
          if (kind === 'shell' && commandTokens[bodyIndex]?.value === '--') {
            bodyIndex++
          }
          const bodyToken = commandTokens[bodyIndex]
          if (bodyToken) {
            sub.interpreterBody = bodyToken.value
            if (kind === 'shell' && depth < MAX_INTERPRETER_DEPTH) {
              sub.nested = normalizeCommand(bodyToken.value, depth + 1)
            }
          }
          break
        }
      }
    }
  }

  return sub
}

interface HeredocBody {
  kind: InterpreterKind
  body: string
}

/**
 * Command-start boundary (mirrors SEPARATORS — start of string or right
 * after `;` `&&` `||` `|` `&` newline), then a bare interpreter token
 * (optionally followed by short/long flags), then a heredoc operator `<<`
 * or `<<-`, then a delimiter word — bare or quoted with `'`/`"`.
 *
 * Delimiter charset this recognizes is intentionally narrow (`[A-Za-z_]
 * [A-Za-z0-9_]*` — covers `EOF`, `PYEOF`, any ordinary identifier-shaped
 * delimiter). Real bash allows a much wider delimiter charset, and the
 * quote form changes whether `$`-expansion happens INSIDE the body — both
 * irrelevant here since this only needs to find where the body ENDS to
 * expose it as a matching surface, not to interpret expansion. An unusual
 * delimiter outside this charset is a documented remaining gap (see
 * SECURITY.md), same spirit as the busybox-argv0 gap noted above.
 */
// The flag-cluster group uses a single fixed leading `-` (not `-{1,2}`)
// with `-` also inside the trailing char class for `--eval`-style long
// flags — avoids two quantifiers competing over the same `-` characters,
// which is the classic shape for catastrophic backtracking on non-matching
// input (measured: no blowup either way at MAX_INPUT_LEN, kept anyway).
const HEREDOC_START_RE =
  /(?:^|[;&|\n]|&&|\|\|)[ \t]*([A-Za-z0-9_./\\-]+)(?:[ \t]+-[A-Za-z0-9_-]*)*[ \t]*<<(-)?[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/g

/**
 * Fix (5): recognize a bare interpreter invocation immediately followed by
 * a heredoc operator (`<interpreter> [flags...] <<[-] [']DELIM[']`) and
 * expose the heredoc body — the lines between the operator's line and the
 * line that is EXACTLY the delimiter (leading tabs stripped first when
 * `<<-` was used) — as an additional surface, the same way `-c`/`-e` flag
 * bodies are exposed in normalizeSubcommand. Before this, a heredoc body
 * was never matched against anything: `bash <<'EOF' ... EOF` and
 * `python3 <<'PYEOF' ... PYEOF` were completely invisible to every
 * command-text rule (the root cause of a self-protection bypass — see
 * SECURITY.md / the audit that found it: writing to `.keel/rules.yaml` via
 * a Python heredoc).
 *
 * Operates on the RAW string directly rather than through tokenize() /
 * splitTopLevel(): a heredoc body is genuinely multi-line, and
 * splitTopLevel's per-newline subcommand splitting (needed for `x && y`,
 * unrelated to heredocs) already chops it into independent lines before any
 * per-subcommand logic runs, so there is no single subcommand that cleanly
 * owns "the whole heredoc + body". This pass is purely additive — same
 * invariant as the `-lc` short-cluster match above: it only ever adds
 * surfaces, never suppresses one, so it runs independently without
 * changing how subcommands are split.
 */
function extractHeredocs(raw: string): HeredocBody[] {
  const results: HeredocBody[] = []
  HEREDOC_START_RE.lastIndex = 0
  let m: RegExpExecArray | null
  let guard = 0
  while (guard < MAX_SUBCOMMANDS && (m = HEREDOC_START_RE.exec(raw))) {
    guard++
    const interpToken = m[1]
    const tabStrip = m[2] === '-'
    const delim = m[3] ?? m[4] ?? m[5]
    const kind = delim ? classifyInterpreter(basename(interpToken)) : null
    if (!kind) continue

    const opLineEnd = raw.indexOf('\n', HEREDOC_START_RE.lastIndex)
    if (opLineEnd === -1) continue // operator has no following line: no body to extract
    const bodyStart = opLineEnd + 1
    const rest = raw.slice(bodyStart)
    const escapedDelim = delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const delimLineRe = new RegExp('^' + (tabStrip ? '\\t*' : '') + escapedDelim + '[ \\t]*$', 'm')
    const end = delimLineRe.exec(rest)
    if (!end) continue // unterminated heredoc (malformed input): best-effort, skip — never throw

    const body = end.index > 0 ? rest.slice(0, end.index - 1) : ''
    results.push({ kind, body })
    // Resume scanning after the delimiter line — avoids re-matching inside
    // the body text and guarantees forward progress (bounded by `guard`
    // regardless).
    HEREDOC_START_RE.lastIndex = bodyStart + end.index + end[0].length
  }
  return results
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

    // Heredoc bodies (fix 5): a raw-string-level pass, independent of the
    // subcommand loop above — see extractHeredocs doc for why.
    for (const hd of extractHeredocs(raw)) {
      if (!surfaces.includes(hd.body)) surfaces.push(hd.body)
      if (hd.kind === 'shell' && depth < MAX_INTERPRETER_DEPTH) {
        const nested = normalizeCommand(hd.body, depth + 1)
        for (const s of nested.surfaces) if (!surfaces.includes(s)) surfaces.push(s)
      }
    }

    return { raw, normalized: normalizedFull, subcommands, surfaces, truncated }
  } catch {
    return { raw, normalized: raw, subcommands: [], surfaces: [raw], truncated: true }
  }
}
