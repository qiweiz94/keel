import { existsSync, readFileSync } from 'node:fs'

/**
 * Sandbox detection — informs a SUGGESTION only ("Tier-2 prompt rules could
 * relax to warns"), never a config write. When an OS-level sandbox already
 * contains the blast radius of a command, keel's own prompt-heavy rules are
 * redundant friction; keel never applies the relaxation itself, it only
 * tells the user the option exists (see `keel status` / `keel install`
 * wiring in packages/cli/src/commands/status.ts and install.ts).
 *
 * Every detector below is honest about what it can and cannot prove:
 *   - Docker/container and Codex have real, documented, boolean markers, so
 *     their absence is reported as a definite `false`, not `unknown`.
 *   - Anthropic's sandbox-runtime (the bwrap/seatbelt wrapper Claude Code
 *     uses) has NO public, documented marker a wrapped process can read to
 *     assert "I am sandboxed" — the public docs (code.claude.com/docs/en/
 *     sandboxing, code.claude.com/docs/en/env-vars) and the sandbox-runtime
 *     README describe proxy/CA env vars but nothing that signals sandbox
 *     presence. Source inspection (github.com/anthropic-experimental/
 *     sandbox-runtime, src/sandbox/sandbox-utils.ts generateProxyEnvVars)
 *     shows an internal `SANDBOX_RUNTIME=1` var, but it is (a) undocumented
 *     — no public contract, subject to change without notice — and (b) only
 *     emitted on the branch that wires an HTTP/SOCKS proxy bridge, so a
 *     filesystem-only or network-fully-blocked sandbox may never set it.
 *     Its presence is treated as a low-confidence positive signal; its
 *     absence proves nothing, so absence reports `unknown`, never `false`.
 *   - CI is a documented de-facto convention (`CI=true`, used by GitHub
 *     Actions, GitLab CI, CircleCI, Travis, Buildkite, …) but a CI runner's
 *     isolation varies by provider and job config, so it counts toward
 *     "contained" at low confidence rather than high.
 */

export type SandboxKind = 'container' | 'anthropic-sandbox-runtime' | 'codex' | 'ci'
export type Confidence = 'high' | 'medium' | 'low' | 'none'

export interface SandboxSignal {
  kind: SandboxKind
  /** Short display name for the specific mechanism, e.g. "docker",
   *  "kubernetes", "codex", "ci", "anthropic-sandbox-runtime" — finer
   *  grained than `kind` (several labels share the `container` kind). Used
   *  as the headline in `sandboxSuggestion`. */
  label: string
  /** Human-readable marker description, e.g. "/.dockerenv". */
  detail: string
  confidence: Confidence
}

export interface SandboxDetectionResult {
  /** `true` = at least one signal fired. `'unknown'` = none of the checks
   *  below fired. This is deliberately never `false`: each individual
   *  detector can rule out ITS OWN mechanism (no `/.dockerenv` really does
   *  mean "not this container"), but "sandboxed by anything at all" is an
   *  open-ended question — an undetectable or not-yet-checked-for sandbox
   *  (Firejail, gVisor, a VM, a mechanism this file doesn't know about yet)
   *  can never be ruled out by a finite marker list, and
   *  anthropic-sandbox-runtime specifically has no marker that proves
   *  absence even for itself (see its doc comment). Per-detector results
   *  (which DO distinguish "checked, absent" from "can't tell") are in
   *  `detail`/`signals`. */
  sandboxed: boolean | 'unknown'
  /** Human-readable signal descriptions, one per marker that fired. Empty
   *  when nothing fired (both the `false` and `unknown` cases). */
  signals: string[]
  /** Highest confidence among fired signals; 'none' when nothing fired. */
  confidence: Confidence
  /** Per-detector detail, for callers that want more than the flat summary. */
  detail: SandboxSignal[]
}

/**
 * Injectable I/O so tests can simulate each signal source without touching
 * the real filesystem or environment. Defaults read the real machine.
 */
export interface SandboxProbe {
  env: Record<string, string | undefined>
  existsSync(path: string): boolean
  readFileSync(path: string): string
}

function realProbe(): SandboxProbe {
  return {
    env: process.env,
    existsSync,
    readFileSync: (path: string) => readFileSync(path, 'utf8'),
  }
}

function safeRead(probe: SandboxProbe, path: string): string | null {
  try {
    if (!probe.existsSync(path)) return null
    return probe.readFileSync(path)
  } catch {
    return null
  }
}

/**
 * Docker/container detection.
 *
 * `/.dockerenv` is a Docker-specific marker file created inside every
 * Docker-launched container (not a documented public API, but a stable,
 * widely-relied-on implementation detail — it has existed since Docker
 * 0.x and is checked by, among others, systemd's ConditionVirtualization
 * and countless CI scripts). `/proc/1/cgroup` containing "docker",
 * "kubepods", or "containerd" is the standard cgroup-path heuristic for
 * container runtimes on Linux. `KUBERNETES_SERVICE_HOST` is a documented
 * Kubernetes-injected env var present in every pod.
 *
 * On macOS (this dev machine) none of these paths exist on bare metal:
 * `/proc` doesn't exist at all, and `/.dockerenv` is never created outside
 * a Linux container namespace — so this must not false-positive on darwin.
 */
export function detectContainer(probe: SandboxProbe): SandboxSignal[] {
  const signals: SandboxSignal[] = []

  if (probe.existsSync('/.dockerenv')) {
    signals.push({ kind: 'container', label: 'docker', detail: '/.dockerenv', confidence: 'high' })
  }

  const cgroup = safeRead(probe, '/proc/1/cgroup')
  if (cgroup) {
    if (/docker/.test(cgroup)) {
      signals.push({ kind: 'container', label: 'docker', detail: '/proc/1/cgroup (docker)', confidence: 'high' })
    } else if (/kubepods/.test(cgroup)) {
      signals.push({ kind: 'container', label: 'kubernetes', detail: '/proc/1/cgroup (kubepods)', confidence: 'high' })
    } else if (/containerd/.test(cgroup)) {
      signals.push({ kind: 'container', label: 'container', detail: '/proc/1/cgroup (containerd)', confidence: 'high' })
    }
  }

  if (probe.env.KUBERNETES_SERVICE_HOST) {
    signals.push({ kind: 'container', label: 'kubernetes', detail: 'KUBERNETES_SERVICE_HOST', confidence: 'high' })
  }

  return signals
}

/**
 * Anthropic sandbox-runtime (the bwrap/seatbelt wrapper Claude Code's
 * sandboxed Bash tool and the standalone @anthropic-ai/sandbox-runtime
 * package use).
 *
 * No documented marker exists for a wrapped process to detect its own
 * containment — see the module doc comment above. `SANDBOX_RUNTIME=1` is
 * an internal, undocumented env var observed in source
 * (src/sandbox/sandbox-utils.ts: generateProxyEnvVars) that IS set on the
 * proxy-bridge branch (network isolation with an HTTP/SOCKS proxy
 * configured), so its presence is a real but low-confidence signal — it
 * could change or vanish across sandbox-runtime versions without notice,
 * and it is only wired on that one branch, not on every sandboxed
 * invocation. Its absence does NOT prove the process is unsandboxed
 * (filesystem-only or fully-network-blocked configurations may never set
 * it), so absence is reported as `unknown`, never folded into `false`.
 */
export function detectAnthropicSandboxRuntime(probe: SandboxProbe): SandboxSignal[] {
  if (probe.env.SANDBOX_RUNTIME === '1') {
    return [{
      kind: 'anthropic-sandbox-runtime',
      label: 'anthropic-sandbox-runtime',
      detail: 'SANDBOX_RUNTIME=1 (undocumented internal marker, only set on the proxy-bridge code path — treat as suggestive, not conclusive)',
      confidence: 'low',
    }]
  }
  return []
}

/**
 * Codex CLI sandbox (OpenAI).
 *
 * `CODEX_SANDBOX_NETWORK_DISABLED=1` is documented in codex's own
 * AGENTS.md as being set whenever a command runs through Codex's shell
 * tool under network restriction, on macOS, Linux, and Windows alike —
 * the most reliable cross-platform Codex marker.
 * `CODEX_SANDBOX=seatbelt` is documented for macOS specifically: it is
 * set on any child process spawned via Apple's Seatbelt
 * (`/usr/bin/sandbox-exec`), independent of network policy. Codex's Linux
 * value for `CODEX_SANDBOX` (landlock-based) is not documented in a
 * source we could confirm, so presence of the variable at all — any
 * value — is still treated as a signal, just at lower confidence than
 * the confirmed macOS value.
 */
export function detectCodexSandbox(probe: SandboxProbe): SandboxSignal[] {
  const signals: SandboxSignal[] = []

  if (probe.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
    signals.push({ kind: 'codex', label: 'codex', detail: 'CODEX_SANDBOX_NETWORK_DISABLED=1', confidence: 'high' })
  }

  if (probe.env.CODEX_SANDBOX === 'seatbelt') {
    signals.push({ kind: 'codex', label: 'codex', detail: 'CODEX_SANDBOX=seatbelt', confidence: 'high' })
  } else if (probe.env.CODEX_SANDBOX) {
    signals.push({ kind: 'codex', label: 'codex', detail: `CODEX_SANDBOX=${probe.env.CODEX_SANDBOX} (undocumented value for this platform)`, confidence: 'medium' })
  }

  return signals
}

/**
 * Generic CI. `CI=true` is a de-facto convention set by GitHub Actions,
 * GitLab CI, CircleCI, Travis, Buildkite, and most other CI providers —
 * not a formal spec, but reliable in practice. Counts as "contained" for
 * suggestion purposes because most CI jobs run in a throwaway VM or
 * container, but at low confidence: some self-hosted runners execute
 * directly on a persistent host with no isolation at all.
 */
export function detectCI(probe: SandboxProbe): SandboxSignal[] {
  if (probe.env.CI === 'true' || probe.env.CI === '1') {
    return [{ kind: 'ci', label: 'ci', detail: `CI=${probe.env.CI}`, confidence: 'low' }]
  }
  return []
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1, none: 0 }

/**
 * Runs every detector and combines the results. On bare-metal darwin (this
 * dev machine) every detector below finds nothing, so this returns
 * `{ sandboxed: 'unknown', signals: [], confidence: 'none' }` — never
 * `false` (see the `sandboxed` field doc on `SandboxDetectionResult`).
 * `keel status` treats both `false` and `'unknown'` identically (no
 * suggestion printed); only `true` prints anything.
 */
export function detectSandbox(probe: SandboxProbe = realProbe()): SandboxDetectionResult {
  const detail = [
    ...detectContainer(probe),
    ...detectAnthropicSandboxRuntime(probe),
    ...detectCodexSandbox(probe),
    ...detectCI(probe),
  ]

  const signals = detail.map(s => `${s.kind}: ${s.detail}`)
  const anyTrue = detail.length > 0
  const confidence: Confidence = anyTrue
    ? detail.reduce<Confidence>((best, s) => (CONFIDENCE_RANK[s.confidence] > CONFIDENCE_RANK[best] ? s.confidence : best), 'none')
    : 'none'

  return { sandboxed: anyTrue ? true : 'unknown', signals, confidence, detail }
}

/**
 * Renders the print-only `keel status` / `keel install` suggestion line.
 * Returns null when nothing is detected (no noise) or when detection is
 * merely `'unknown'` — a suggestion needs a positive signal to point at.
 *
 * The suggestion never names a specific rule action to change; it points
 * at the two supported, user-driven relaxation paths (`keel level`, and
 * per-rule overrides) and says explicitly that keel will not apply either
 * one automatically.
 */
export function sandboxSuggestion(result: SandboxDetectionResult): string | null {
  if (result.sandboxed !== true || result.detail.length === 0) return null
  const top = result.detail.reduce((best, s) => (CONFIDENCE_RANK[s.confidence] > CONFIDENCE_RANK[best.confidence] ? s : best))
  return (
    `sandbox detected (${top.label} via ${top.detail}) — Tier-2 prompts could relax to warns: ` +
    `keel level sprint --project, or per-rule overrides; keel never applies this automatically`
  )
}
