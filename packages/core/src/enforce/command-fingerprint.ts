/**
 * Command fingerprinting for the stuck-loop detector.
 *
 * "Identical" means *same failing attempt*, not the same string — real
 * traces show `git commit -m "fix: ..."` retried with different messages,
 * `npm test -- --grep x` re-run with different filters, and temp paths
 * that change per run. The fingerprint normalizes those away.
 */

export function commandFingerprint(command: string): string {
  let s = command
    .replace(/\s+/g, ' ')
    .trim()
    // Temp paths vary per run.
    .replace(/(\/var\/folders\/)[^\s]+/g, '$1<TMP>')
    .replace(/(^|\s)(\/tmp\/|\$TMPDIR\/)[^\s]*/g, '$1<TMP>')
    // git commit messages vary per retry.
    .replace(/(-m\s+["'])[^"']*(["'])/g, '$1<msg>$2')
    // Long quoted strings are usually dynamic payloads.
    .replace(/"[^"]{12,}"/g, '"<s>"')
    .replace(/'[^']{12,}'/g, "'<s>'")
    // Hex runs (hashes, ids, tokens).
    .replace(/\b[0-9a-f]{8,}\b/gi, '<H>')
    // Numeric literals (pids, ports, timestamps, counts).
    .replace(/\b\d+\b/g, '<N>')
    // Flag values (--reporter=dot vs --reporter=verbose is the same retry).
    .replace(/(--[\w-]+)=[^\s]+/g, '$1')
    .trim()
  if (s.length > 160) s = s.slice(0, 160)
  return s
}

/** Near-identical fallback: token-set Jaccard for long commands. */
export function nearIdentical(a: string, b: string): boolean {
  const fa = commandFingerprint(a)
  const fb = commandFingerprint(b)
  if (fa === fb) return true
  if (fa.length < 40 || fb.length < 40) return false
  const stopwords = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'then', 'this', 'that', '&&', '|', '||', ';', '2>&1'])
  const tokens = (s: string) => new Set(s.split(/\s+/).filter((t) => t.length >= 3 && !stopwords.has(t)))
  const ta = tokens(fa)
  const tb = tokens(fb)
  if (ta.size === 0 || tb.size === 0) return false
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union > 0 && inter / union >= 0.8
}
