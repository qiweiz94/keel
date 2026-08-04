import { fetchPage, ResearchError } from './fetcher.js'

/**
 * Search backends for the keel research layer.
 *
 * `duckduckgo` — keyless HTML endpoint (default, zero config).
 * `api`       — user-configured search API (KEEL_SEARCH_API_URL + key).
 * `none`      — no network search; directives fall back to platform-native
 *               search (Hermes web_search, OpenClaw skills).
 */

export interface SearchResult {
  title: string
  url: string
  snippet: string
  rank: number
}

export interface SearchConfig {
  backend: 'duckduckgo' | 'api' | 'none'
  apiUrl?: string
  apiKey?: string
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
}

/** Parse the DuckDuckGo HTML results table into { title, url, snippet }. */
export function parseDuckDuckGo(html: string, maxResults: number): SearchResult[] {
  const out: SearchResult[] = []
  const resultRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  let rank = 0
  while ((m = resultRe.exec(html)) !== null && out.length < maxResults) {
    const rawUrl = decodeEntities(m[1].replace(/&amp;/g, '&'))
    let url = rawUrl
    const ddg = rawUrl.match(/uddg=([^&]+)/)
    if (ddg) url = decodeURIComponent(ddg[1])
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim())
    const snippet = decodeEntities(m[3].replace(/<[^>]+>/g, '').trim())
    if (!url.startsWith('http')) continue
    out.push({ title, url, snippet, rank: ++rank })
  }
  return out
}

export async function webSearch(query: string, config: SearchConfig, maxResults: number): Promise<SearchResult[]> {
  if (config.backend === 'none') {
    throw new ResearchError('http_error', 'search backend is disabled (KEEL_SEARCH_BACKEND=none)')
  }
  if (config.backend === 'api') {
    if (!config.apiUrl) throw new ResearchError('http_error', 'KEEL_SEARCH_API_URL is not set')
    const url = new URL(config.apiUrl)
    url.searchParams.set('q', query)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      })
      if (!res.ok) throw new ResearchError('http_error', `search API HTTP ${res.status}`)
      const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; snippet?: string }> }
      return (data.results || []).slice(0, maxResults).map((r, i) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.snippet || '',
        rank: i + 1,
      }))
    } catch (err) {
      if (err instanceof ResearchError) throw err
      if (controller.signal.aborted) throw new ResearchError('timeout', 'search API timed out')
      throw new ResearchError('http_error', `search API failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  // duckduckgo default: fetch the HTML endpoint and parse the results table.
  const html = await fetchPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { maxText: 500_000 })
  return parseDuckDuckGo(html.text, maxResults)
}
