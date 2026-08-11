/**
 * Test-oracle weakening signatures — the content-diff half of the
 * test-oracle-tampering detector (see oracle-tracker.ts for the recency
 * half, and session/proposals/test-oracle-tampering.yaml for the shipped
 * rule and its honest confidence/false-positive discussion).
 *
 * These are regex/line-diff HEURISTICS over unparsed source, not an AST.
 * That is a deliberate scope limit, not an oversight: a deterministic,
 * dependency-free detector that runs inline in the enforcement pipeline
 * cannot afford a per-language parser, and the recency gate (oracle-
 * tracker.ts) is what keeps the false-positive rate low enough for
 * `mode: observe` to be worth shipping even with heuristic detection.
 *
 * Every function here is pure (no I/O, no state) so it can be tested and
 * reasoned about independently of the pipeline wiring.
 */

export interface WeakeningSignal {
  id: string
  detail: string
}

// ── Signature 1: skip/only directives added ──
//
// it.skip/describe.skip/xit/xdescribe/xtest (JS), @pytest.mark.skip /
// pytest.mark.xfail / pytest.skip( (Python), t.Skip/t.SkipNow (Go), .only/
// fit/fdescribe (JS — narrowing to one test silently stops every OTHER
// test in the file from running, which is the same "the suite goes quiet"
// effect as skip).
const SKIP_RE = /\b(?:it|test|describe)\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\bxtest\s*\(|@pytest\.mark\.skip\b|@pytest\.mark\.xfail\b|\bpytest\.skip\s*\(|\bpytest\.mark\.skipif\b|\bt\.Skip\s*\(|\bt\.SkipNow\s*\(/g
const ONLY_RE = /\b(?:it|test|describe)\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(/g

// ── Signature 2: assertions removed ──
const ASSERTION_RE = /\bexpect\s*\(|\bassert[_A-Za-z]*\s*\(|\bself\.assert[A-Za-z]*\s*\(|(^|[^.\w])assert\s+\S/gm

// ── Signature 3: test blocks deleted ──
const TEST_DECL_RE = /\b(?:it|test)\s*\(\s*['"`]|\bdef\s+test_\w+\s*\(/g

// Signature 4 (snapshot-file-rewrite) is path-based, not text-based — see
// the `filePath` check inside detectWeakening below; there is no regex here.

// ── Signature 5: timeout/retry inflation ──
const TIMEOUT_RETRY_RE = /\b(timeout|retries|retry|maxRetries|max_retries)\s*[:=(]\s*(\d+)/gi

function countMatches(re: RegExp, text: string): number {
  re.lastIndex = 0
  return (text.match(re) || []).length
}

/** Non-empty, trimmed lines — the unit line-diffing operates on. */
function lines(text: string): string[] {
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
}

// ── Signature 6: expected-value rewrite ──
// Assertion-call lines whose comparison target we try to pair across old
// and new by matching everything up to (and including) the opening paren
// of the comparison method — `expect(result.total).toBe(` — so a rewrite
// of just the literal argument is caught without a full parser.
const ASSERT_CALL_PREFIX_RE = /^(.*?\b(?:toBe|toEqual|toStrictEqual|toMatchObject|toMatchSnapshot|assertEqual|assertEquals|assert_equal)\s*\()/

function expectedValueRewrites(oldText: string, newText: string): number {
  const oldLines = lines(oldText)
  const newLines = lines(newText)
  const newSet = new Set(newLines)
  const oldSet = new Set(oldLines)
  const removed = oldLines.filter(l => !newSet.has(l))
  const added = newLines.filter(l => !oldSet.has(l))
  let rewrites = 0
  for (const r of removed) {
    const m = ASSERT_CALL_PREFIX_RE.exec(r)
    if (!m) continue
    const prefix = m[1]
    // A same-prefix line among the additions, but not textually identical
    // (identical would mean it wasn't actually removed), is the same
    // assertion call with a different expected value.
    if (added.some(a => a.startsWith(prefix) && a !== r)) rewrites++
  }
  return rewrites
}

function timeoutInflations(oldText: string, newText: string): string[] {
  const collect = (text: string): Map<string, number> => {
    const out = new Map<string, number>()
    let m: RegExpExecArray | null
    TIMEOUT_RETRY_RE.lastIndex = 0
    while ((m = TIMEOUT_RETRY_RE.exec(text))) {
      const name = m[1].toLowerCase()
      const value = Number(m[2])
      // Last write wins per name — good enough for a per-file heuristic;
      // a file rarely redefines the same timeout name with different
      // legitimate intents.
      out.set(name, value)
    }
    return out
  }
  const oldVals = collect(oldText)
  const newVals = collect(newText)
  const flags: string[] = []
  for (const [name, newVal] of newVals) {
    const oldVal = oldVals.get(name)
    if (oldVal === undefined || oldVal <= 0) continue
    // Require a real inflation, not incidental noise. A pure ratio
    // threshold over-fires on small integers (1→2 is technically a
    // doubling but is a routine retry-count bump, not a sweep), so this
    // requires BOTH a large absolute jump (5+) AND at least tripling —
    // 1→2 does not fire, 1→10 does, 2000→30000 (a typical timeout
    // inflation) does.
    if (newVal > oldVal && newVal - oldVal >= 5 && newVal / oldVal >= 3) {
      flags.push(`${name} ${oldVal}→${newVal}`)
    }
  }
  return flags
}

/**
 * Detect weakening signatures in an edit to a test file. `oldText` is the
 * content before the edit (on-disk content, or the Edit tool's oldString
 * snippet); `newText` is the content after. Either may be empty (e.g. a
 * brand-new file has no oldText; an Edit-tool call whose oldString/
 * newString cover only the changed region has no full-file view — both
 * are handled: an empty oldText means nothing can have been REMOVED, so
 * only the skip/only and snapshot-path checks can fire).
 *
 * Returns an empty array when the edit looks like a pure addition or an
 * identity-preserving refactor (rename, reorder) — see the false_positives
 * list in session/proposals/test-oracle-tampering.yaml for what this is
 * designed to let through.
 */
export function detectWeakening(oldText: string, newText: string, filePath?: string): WeakeningSignal[] {
  const signals: WeakeningSignal[] = []

  // Snapshot files are opaque generated data — the presence of a full
  // rewrite is the signal, not any particular line content.
  if (filePath && /\.snap$|\/__snapshots__\//.test(filePath)) {
    signals.push({ id: 'snapshot-file-rewrite', detail: `snapshot file "${filePath}" rewritten` })
  }

  const skipDelta = countMatches(SKIP_RE, newText) - countMatches(SKIP_RE, oldText)
  if (skipDelta > 0) {
    signals.push({ id: 'skip-added', detail: `${skipDelta} skip/xfail directive(s) added` })
  }
  const onlyDelta = countMatches(ONLY_RE, newText) - countMatches(ONLY_RE, oldText)
  if (onlyDelta > 0) {
    signals.push({ id: 'only-added', detail: `${onlyDelta} .only/fit/fdescribe directive(s) added (silences the rest of the file)` })
  }

  const assertionDelta = countMatches(ASSERTION_RE, oldText) - countMatches(ASSERTION_RE, newText)
  if (assertionDelta > 0) {
    signals.push({ id: 'assertions-removed', detail: `${assertionDelta} assertion(s) removed with no comparable addition` })
  }

  const testBlockDelta = countMatches(TEST_DECL_RE, oldText) - countMatches(TEST_DECL_RE, newText)
  if (testBlockDelta > 0) {
    signals.push({ id: 'test-block-deleted', detail: `${testBlockDelta} test block(s) deleted` })
  }

  if (oldText && newText) {
    const rewrites = expectedValueRewrites(oldText, newText)
    if (rewrites > 0) {
      signals.push({ id: 'expected-value-rewrite', detail: `${rewrites} expected-value comparison(s) rewritten` })
    }
    const inflations = timeoutInflations(oldText, newText)
    if (inflations.length) {
      signals.push({ id: 'timeout-retry-inflation', detail: `timeout/retry inflated: ${inflations.join(', ')}` })
    }
  }

  return signals
}
