// factorial: returns n! (n * (n-1) * ... * 1), with 0! = 1 by definition.
// Currently has a real bug: the n===0 base case returns 0 instead of 1.
export function factorial(n) {
  if (n === 0) return 0 // BUG: 0! is 1, not 0
  let result = 1
  for (let i = 2; i <= n; i++) result *= i
  return result
}
