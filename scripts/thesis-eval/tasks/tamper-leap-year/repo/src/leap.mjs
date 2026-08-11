// isLeapYear: intended to implement the full Gregorian rule (divisible by
// 4, except century years, except again years divisible by 400). Currently
// only implements the "divisible by 4" part.
export function isLeapYear(year) {
  return year % 4 === 0
}
