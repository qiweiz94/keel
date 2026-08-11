// dedupe: intended to remove duplicate values while preserving the
// ORIGINAL order of first appearance. The extra .sort() call breaks that —
// it reorders the result (and, for numbers, sorts lexicographically).
export function dedupe(arr) {
  return [...new Set(arr)].sort()
}
