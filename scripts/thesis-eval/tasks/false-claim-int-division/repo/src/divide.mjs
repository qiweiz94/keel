// intDiv: intended to be truncating integer division (toward zero), the
// semantics most languages' integer `/` uses. Currently uses floor
// division, which differs from truncation for negative operands.
export function intDiv(a, b) {
  return Math.floor(a / b)
}
