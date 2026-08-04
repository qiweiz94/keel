import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import chalk from 'chalk'
import { collectState, switchLevel } from './dashboard.js'
import type { ProtectionLevel } from '../core/types.js'

/**
 * `keel dashboard --web` — a real browser UI for the dial and enforcement
 * state. Security model (the reason a web surface can be human-only):
 *
 * - The server binds 127.0.0.1 and requires a one-time bearer token.
 * - The token is printed on the TERMINAL SCREEN only — it is never written
 *   to disk, so nothing on the filesystem can be curled by an agent.
 * - Starting the server requires a TTY (an agent's shell has none), so the
 *   whole surface is human-only by construction — the same property the
 *   terminal dashboard has, without the keyboard-only interaction.
 *
 * Endpoints:
 *   GET  /                 → the UI page (static shell, no data)
 *   GET  /api/state        → dashboard state (same shape as --json)
 *   POST /api/dial         → { level, target? } → switches the dial
 *
 * The token is handed to the browser as a URL hash fragment (#token=…):
 * fragments are never sent to servers and never leak through referrer
 * headers, and the page re-sends the token as a Bearer header on every API
 * call. The server still accepts a query-string token for tooling that
 * cannot carry headers.
 */

const VALID_LEVELS: ProtectionLevel[] = ['sprint', 'balanced', 'protect']

function pageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>keel dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #e6edf3; font: 14px/1.5 -apple-system, "SF Pro Text", system-ui, sans-serif; padding: 24px; max-width: 860px; margin: 0 auto; }
  h1 { font-size: 20px; display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  h1 .anchor { color: #58a6ff; }
  .sub { color: #8b949e; margin-bottom: 20px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px; margin-bottom: 14px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #8b949e; margin-bottom: 12px; }
  .dials { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  button.dial { padding: 18px 10px; font-size: 15px; font-weight: 600; border-radius: 8px; border: 2px solid #30363d; background: #21262d; color: #e6edf3; cursor: pointer; transition: transform .05s ease, border-color .15s ease; }
  button.dial:hover { border-color: #8b949e; }
  button.dial:active { transform: scale(.97); }
  button.dial.active { border-color: #58a6ff; box-shadow: 0 0 0 1px #58a6ff; }
  button.dial.sprint.active { border-color: #d29922; box-shadow: 0 0 0 1px #d29922; }
  button.dial.protect.active { border-color: #f85149; box-shadow: 0 0 0 1px #f85149; }
  button.dial .desc { display: block; font-size: 11px; font-weight: 400; color: #8b949e; margin-top: 4px; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .kv { color: #8b949e; }
  .kv b { color: #e6edf3; font-weight: 600; }
  .target { margin-top: 12px; display: flex; align-items: center; gap: 10px; }
  .target button { padding: 6px 14px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #e6edf3; cursor: pointer; font-size: 12px; }
  .target button.active { border-color: #58a6ff; color: #58a6ff; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #21262d; font-size: 13px; }
  th { color: #8b949e; font-weight: 500; }
  td.src { color: #8b949e; font-size: 12px; word-break: break-all; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge.ok { background: #1f6feb33; color: #58a6ff; }
  .badge.warn { background: #d2992233; color: #d29922; }
  .badge.bad { background: #f8514933; color: #f85149; }
  .block { font-size: 13px; padding: 5px 0; border-bottom: 1px solid #21262d; }
  .block .time { color: #8b949e; }
  .block .act { font-weight: 600; }
  .act.deny, .act.block { color: #f85149; }
  .act.prompt { color: #d29922; }
  .live { display: inline-flex; align-items: center; gap: 6px; color: #3fb950; font-size: 12px; }
  .live .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; animation: pulse 2s infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 18px; font-size: 13px; display: none; }
  #toast.show { display: block; }
  #toast.ok { border-color: #3fb950; }
  #toast.err { border-color: #f85149; }
  /* A dead session must not fail silently: the toast auto-hides, so an
     unauthenticated page would otherwise sit there full of placeholders
     with no explanation. This banner persists until the page is reloaded
     with a valid token. */
  #banner { display: none; background: #f8514922; border: 1px solid #f85149; border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; font-size: 13px; }
  #banner.show { display: block; }
  #banner b { color: #f85149; display: block; margin-bottom: 6px; font-size: 14px; }
  #banner code { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 2px 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
  <h1><span class="anchor">⚓</span> keel dashboard</h1>
  <div class="sub">Speed dial · approvals · enforcement health <span class="live"><span class="dot"></span>live</span></div>

  <div id="banner"></div>

  <div class="card">
    <h2>Speed dial</h2>
    <div class="dials">
      <button class="dial sprint" data-level="sprint">SPRINT<span class="desc">deny rules warn only</span></button>
      <button class="dial balanced" data-level="balanced">BALANCED<span class="desc">warn then block · default</span></button>
      <button class="dial protect" data-level="protect">PROTECT<span class="desc">block first · high stakes</span></button>
    </div>
    <div class="target">
      <span class="kv">Switch the dial in:</span>
      <button data-target="global">Global</button>
      <button data-target="project">Project</button>
      <span class="kv" id="target-hint"></span>
    </div>
  </div>

  <div class="card">
    <h2>Status</h2>
    <div class="row">
      <span class="kv">Speed dial: <b id="st-dial">—</b></span>
      <span class="kv">Kill switch: <b id="st-kill">—</b></span>
      <span class="kv">Overrides: <b id="st-overrides">—</b></span>
      <span class="kv">Plugin: <b id="st-plugin">—</b></span>
    </div>
    <div class="row" style="margin-top:8px">
      <span class="kv">Active at current dial: <b id="st-active">—</b></span>
    </div>
  </div>

  <div class="card">
    <h2>Rules</h2>
    <table>
      <thead><tr><th>Scope</th><th>Rules</th><th>Source</th></tr></thead>
      <tbody id="rules-body"></tbody>
    </table>
  </div>

  <div class="card">
    <h2>Recent blocks</h2>
    <div id="blocks"></div>
  </div>

  <div id="toast"></div>

<script>
// The token travels in the URL hash fragment (#token=...): fragments are
// never sent to servers and never leak through referrer headers. The API
// calls below carry it as a Bearer header instead.
const token = new URLSearchParams(location.hash.slice(1)).get('token') || ''
let target = 'global'
let dial = null

function banner(title, html) {
  const b = document.getElementById('banner')
  b.innerHTML = '<b>' + title + '</b>' + html
  b.className = 'show'
}

// Opening the bare http://127.0.0.1:PORT/ (no #token=...) is the single most
// common way to land here: the page renders, every API call 401s, and without
// this the only signal was a toast that vanished after 2.6 seconds.
if (!token) {
  banner('Missing access token',
    'This page needs the full URL printed in your terminal, including the ' +
    '<code>#token=…</code> fragment — it is what authenticates you, and it is ' +
    'never written to disk.<br><br>If you no longer have it, restart the server: ' +
    '<code>keel dashboard --web</code>')
}

async function api(path, opts = {}) {
  let res
  try {
    res = await fetch(path, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token },
    })
  } catch {
    // The server process exited (Ctrl+C, or the terminal it ran in closed).
    banner('Cannot reach the keel dashboard server',
      'The server that served this page is no longer running. It stops when you ' +
      'press Ctrl+C or close its terminal.<br><br>Restart it with ' +
      '<code>keel dashboard --web</code> and open the new URL it prints.')
    return null
  }
  if (res.status === 401) {
    banner('Not authorized',
      'The token in this URL is not valid for the running server — it changes ' +
      'every time the server restarts.<br><br>Run <code>keel dashboard --web</code> ' +
      'again and open the URL it prints.')
    return null
  }
  document.getElementById('banner').className = ''
  return res.json()
}

function toast(msg, kind) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.className = 'show ' + (kind || 'ok')
  setTimeout(() => (t.className = ''), 2600)
}

async function refresh() {
  const s = await api('/api/state')
  if (!s) return
  dial = s.dial
  document.getElementById('st-dial').textContent = (s.dial || 'balanced').toUpperCase()
  const ks = s.killSwitch
  document.getElementById('st-kill').textContent = ks.state === 'enabled' ? 'active' : ks.state === 'corrupt' ? 'CORRUPT — stays ON' : 'DISABLED'
  document.getElementById('st-kill').style.color = ks.state === 'enabled' ? '#3fb950' : ks.state === 'corrupt' ? '#f85149' : '#d29922'
  document.getElementById('st-overrides').textContent = s.overrides.length ? s.overrides.map(o => o.id + ' (' + o.minutes_left + 'm)').join(', ') : 'none armed'
  document.getElementById('st-plugin').textContent = s.pluginInstalled ? 'installed' : 'not installed'
  document.getElementById('st-active').textContent = s.active + ' of ' + s.total
  document.querySelectorAll('button.dial').forEach(b => b.classList.toggle('active', b.dataset.level === s.dial))
  document.querySelectorAll('.target button').forEach(b => b.classList.toggle('active', b.dataset.target === target))
  document.getElementById('target-hint').textContent = target === 'global' ? (s.dialGlobal || 'not set') : (s.dialProject || 'not set')
  const rows = s.rules.map(r => '<tr><td>' + r.scope + '</td><td>' + (r.issues ? '<span class="badge warn">' + r.issues + ' issue(s)</span>' : '<span class="badge ok">' + r.count + '</span>') + '</td><td class="src">' + r.source + '</td></tr>').join('')
  document.getElementById('rules-body').innerHTML = rows || '<tr><td colspan="3" style="color:#8b949e">no rules found</td></tr>'
  const blocks = s.blocks.length ? s.blocks.map(b => '<div class="block"><span class="time">' + new Date(b.t).toLocaleTimeString() + '</span> <span class="act ' + b.action + '">[' + b.action + ']</span> ' + b.tool + ' <span style="color:#8b949e">(' + b.rule_id + ')</span></div>').join('') : '<div style="color:#8b949e">none</div>'
  document.getElementById('blocks').innerHTML = blocks
}

document.querySelectorAll('button.dial').forEach(b => b.addEventListener('click', async () => {
  const res = await api('/api/dial', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: b.dataset.level, target }) })
  if (!res) return
  if (res.ok) { toast(res.message); refresh() } else toast(res.message || 'failed', 'err')
}))

document.querySelectorAll('.target button').forEach(b => b.addEventListener('click', () => {
  target = b.dataset.target
  document.querySelectorAll('.target button').forEach(x => x.classList.toggle('active', x === b))
  refresh()
}))

refresh()
setInterval(refresh, 2000)
</script>
</body>
</html>`
}

export async function dashboardWebCommand(options: { port?: number } = {}) {
  const home = homedir()
  const dir = process.cwd()

  // Human-only by construction: starting the web server requires a TTY (an
  // agent's shell has none). The auth token is printed on the terminal
  // screen and never written to disk, so nothing on the filesystem can be
  // curled by an agent — the control surface stays human-owned.
  if (!process.stdin.isTTY && process.env.KEEL_DASHBOARD_ALLOW_NON_TTY !== '1') {
    console.error(chalk.red('  The web dashboard must be started from your own terminal (a TTY).'))
    console.error(chalk.dim('  Run `keel dashboard` in your terminal for the keyboard panel instead.'))
    process.exit(1)
  }

  const token = randomBytes(16).toString('hex')
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const authed = req.headers.authorization === `Bearer ${token}` || url.searchParams.get('token') === token
    const send = (code: number, body: string, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      res.end(body)
    }

    if (url.pathname === '/api/state') {
      if (!authed) return send(401, JSON.stringify({ error: 'unauthorized' }))
      return send(200, JSON.stringify(collectState(dir, home)))
    }
    if (url.pathname === '/api/dial' && req.method === 'POST') {
      if (!authed) return send(401, JSON.stringify({ error: 'unauthorized' }))
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { level?: string; target?: string }
          if (!parsed.level || !(VALID_LEVELS as string[]).includes(parsed.level)) {
            return send(400, JSON.stringify({ ok: false, message: 'invalid level' }))
          }
          const target = parsed.target === 'project' ? 'project' : 'global'
          const result = switchLevel(target, parsed.level as ProtectionLevel)
          return send(result.ok ? 200 : 400, JSON.stringify({ ok: result.ok, message: result.message }))
        } catch {
          return send(400, JSON.stringify({ ok: false, message: 'bad request' }))
        }
      })
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // The page is a static shell with no data; the token lives in the URL
      // HASH fragment (never sent to the server, never in referrer headers),
      // so the page itself needs no auth. Every API call carries the token.
      return send(200, pageHtml(), 'text/html')
    }
    return send(404, JSON.stringify({ error: 'not found' }))
  })

  await new Promise<void>((resolve) => server.listen(options.port || 0, '127.0.0.1', resolve))
  const actual = (server.address() as { port: number }).port
  const url = `http://127.0.0.1:${actual}/#token=${token}`
  console.log(chalk.bold.cyan('\n  ⚓ keel dashboard — web UI'))
  console.log()
  console.log(`  ${chalk.dim('Open in your browser:')} ${chalk.green(url)}`)
  console.log(chalk.dim('  The token authenticates this session only and is never stored.'))
  console.log(chalk.dim('  Press Ctrl+C to stop the server.'))
  console.log()

  // Convenience: open the browser automatically (macOS). The token is in the
  // hash fragment, so it is not sent anywhere by the browser.
  if (process.platform === 'darwin') {
    try {
      const { spawn } = await import('node:child_process')
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } catch {}
  }
}
