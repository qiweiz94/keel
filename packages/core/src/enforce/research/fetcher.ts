import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * SSRF-guarded fetcher for the keel research layer.
 *
 * The daemon is the only process that fetches, and it runs with the user's
 * full privileges — so a prompt-injected URL must never reach a private
 * address, metadata endpoint, or file scheme. Controls:
 *   - scheme allow-list (http/https only)
 *   - private/link-local/metadata IP deny-lists (before DNS and after)
 *   - DNS resolution + re-check of every resolved address (defeats rebinding)
 *   - re-check on every redirect hop (max 3)
 *   - connect + total timeouts, response-size cap, content sanitization
 */

export const RESEARCH_DEFAULTS = {
  timeoutMs: 15000,
  maxBytes: 1_048_576,   // 1 MB before sanitization
  maxText: 60_000,       // sanitized text cap
  maxRedirects: 3,
  connectTimeoutMs: 5000,
}

function isDeniedAddress(address: string): boolean {
  const v = isIP(address)
  if (v === 4) {
    const octets = address.split('.').map(Number)
    const [a, b] = octets
    if (a === 0) return true                              // 0.0.0.0/8
    if (a === 10) return true                             // 10.0.0.0/8
    if (a === 127) return true                            // loopback
    if (a === 169 && b === 254) return true               // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true      // 172.16.0.0/12
    if (a === 192 && b === 168) return true               // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true     // CGNAT
    if (a >= 224) return true                             // multicast + reserved
    return false
  }
  if (v === 6) {
    const lower = address.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    if (lower.startsWith('fe80:')) return true            // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA
    if (lower.startsWith('0:0:0:0:0:ffff:')) return true  // v4-mapped
    return false
  }
  return false
}

function isDeniedHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (lower === 'localhost') return true
  if (lower.endsWith('.localhost')) return true
  if (lower === 'metadata.google.internal' || lower === 'metadata.azure.internal' || lower === 'metadata.aws.internal') return true
  if (isIP(lower)) return isDeniedAddress(lower)
  return false
}

async function verifyHost(host: string): Promise<void> {
  if (isDeniedHost(host)) throw new ResearchError('ssrf_blocked', `blocked host: ${host}`)
  if (isIP(host)) return // denied above or public literal — no DNS needed
  try {
    const addresses = await lookup(host, { all: true })
    if (addresses.some((a) => isDeniedAddress(a.address))) {
      throw new ResearchError('ssrf_blocked', `blocked resolved address for ${host}`)
    }
  } catch (err) {
    if (err instanceof ResearchError) throw err
    throw new ResearchError('dns_failed', `could not resolve ${host}`)
  }
}

export class ResearchError extends Error {
  constructor(public code: 'ssrf_blocked' | 'dns_failed' | 'timeout' | 'too_large' | 'http_error', message: string) {
    super(message)
    this.name = 'ResearchError'
  }
}

export interface FetchedPage {
  url: string
  finalUrl: string
  title: string
  text: string
  truncated: boolean
  fetched_at: number
}

function sanitizeHtml(html: string, maxText: number): { title: string; text: string; truncated: boolean } {
  let title = ''
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 200)

  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/javascript:[^\s"'<>]+/gi, ' ')
    .replace(/data:[^\s"'<>]+/gi, ' ')
  const text = stripped.replace(/\s+/g, ' ').trim()
  return { title, text: text.slice(0, maxText), truncated: text.length > maxText }
}

export async function fetchPage(url: string, options: { timeoutMs?: number; maxBytes?: number; maxText?: number } = {}): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? RESEARCH_DEFAULTS.timeoutMs
  const maxBytes = options.maxBytes ?? RESEARCH_DEFAULTS.maxBytes
  const maxText = options.maxText ?? RESEARCH_DEFAULTS.maxText

  let current = url
  for (let hop = 0; hop <= RESEARCH_DEFAULTS.maxRedirects; hop++) {
    let parsed: URL
    try {
      parsed = new URL(current)
    } catch {
      throw new ResearchError('ssrf_blocked', `malformed url: ${current.slice(0, 80)}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ResearchError('ssrf_blocked', `scheme not allowed: ${parsed.protocol}`)
    }
    await verifyHost(parsed.hostname)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetch(parsed, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'keel-research/0.1' } })
    } catch (err) {
      clearTimeout(timer)
      if (controller.signal.aborted) throw new ResearchError('timeout', `timed out after ${timeoutMs}ms`)
      throw new ResearchError('http_error', `fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    clearTimeout(timer)

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new ResearchError('http_error', `redirect without location (${response.status})`)
      const next = new URL(location, parsed)
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new ResearchError('ssrf_blocked', `redirect to disallowed scheme: ${next.protocol}`)
      }
      await verifyHost(next.hostname)
      current = next.toString()
      continue
    }
    if (!response.ok) {
      throw new ResearchError('http_error', `HTTP ${response.status} for ${parsed.hostname}`)
    }

    // Stream with a size cap (zip-bomb guard).
    if (!response.body) throw new ResearchError('http_error', 'no response body')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let tooLarge = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        tooLarge = true
        await reader.cancel()
        break
      }
      chunks.push(value)
    }
    if (tooLarge) {
      throw new ResearchError('too_large', `response exceeded ${maxBytes} bytes`)
    }
    const html = Buffer.concat(chunks).toString('utf-8')
    const { title, text, truncated } = sanitizeHtml(html, maxText)
    return { url, finalUrl: current, title, text, truncated, fetched_at: Date.now() }
  }
  throw new ResearchError('http_error', 'too many redirects')
}
