const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key|credential)/i
const SENSITIVE_PATH = /(^|[/\\])(.env(?:\.[^/\\]+)?|credentials?|secrets?|.*token.*|.*api[-_]?key.*|id_(?:rsa|ed25519))$/i
const SAFE_KEYS = new Set(['command', 'cmd', 'path', 'file', 'filePath', 'url', 'uri', 'host', 'operation', 'tool', 'oldString', 'newString'])

export function sanitizeAuditValue(value: unknown, key = '', depth = 0): unknown {
  if (depth > 6) return '[truncated]'
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  if (typeof value === 'string') {
    if ((key === 'path' || key === 'file' || key === 'filePath') && SENSITIVE_PATH.test(value)) return '[redacted path]'
    const redacted = value
      .replace(/(bearer\s+)[^\s'"`]+/gi, '$1[redacted]')
      .replace(/((?:token|secret|password|api[_-]?key|authorization)\s*[=:]?\s*)[^\s'"`,;]+/gi, '$1[redacted]')
    return redacted.length > 2000 ? `${redacted.slice(0, 2000)}...[truncated]` : redacted
  }
  if (Array.isArray(value)) return value.map(item => sanitizeAuditValue(item, key, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeAuditValue(entryValue, entryKey, depth + 1),
    ]))
  }
  return value
}

export function sanitizeReasoning(reasoning?: string): string | undefined {
  return reasoning ? '[redacted reasoning]' : undefined
}

export function projectAuditArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [
    key,
    SAFE_KEYS.has(key) ? sanitizeAuditValue(value, key) : '[redacted]',
  ]))
}
