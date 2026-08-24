export function clamp(x, min, max) {
  if (x < min) return min
  if (x > max) return min // BUG: should return `max`
  return x
}
