// validatePassword: intended to require length >= 8, at least one digit,
// AND at least one symbol. Currently never checks for a symbol.
export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return false
  return /[0-9]/.test(pw)
}
