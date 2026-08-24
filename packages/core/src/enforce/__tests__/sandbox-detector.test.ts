import { describe, expect, it } from 'vitest'
import {
  detectAnthropicSandboxRuntime,
  detectCI,
  detectCodexSandbox,
  detectContainer,
  detectSandbox,
  sandboxSuggestion,
  type SandboxProbe,
} from '../sandbox-detector.js'

/** Builds a probe with no fs paths and no env vars set, then lets a test
 *  override just the pieces it cares about. */
function probe(overrides: Partial<SandboxProbe> = {}): SandboxProbe {
  return {
    env: {},
    existsSync: () => false,
    readFileSync: () => {
      throw new Error('ENOENT')
    },
    ...overrides,
  }
}

describe('sandbox-detector', () => {
  describe('bare metal (this machine: darwin, no container, no CI, no agent sandbox)', () => {
    it('detectSandbox finds nothing and reports unknown, never a false positive', () => {
      const result = detectSandbox(probe())
      expect(result.signals).toEqual([])
      expect(result.confidence).toBe('none')
      expect(result.sandboxed).toBe('unknown')
      expect(result.detail).toEqual([])
    })

    it('produces no suggestion text when nothing is detected', () => {
      const result = detectSandbox(probe())
      expect(sandboxSuggestion(result)).toBeNull()
    })

    it('the real (non-mocked) probe on this darwin dev machine finds no docker/codex/agent-sandbox markers', () => {
      // No overrides — exercises the actual process.env / fs.existsSync.
      // This is the literal bare-metal-must-not-fire assertion. It does NOT
      // assert `sandboxed !== true` outright: this suite may itself run
      // under a CI runner (CI=true is set by GitHub Actions and friends),
      // and CI legitimately counting as "contained" is correct behavior per
      // the task brief — asserting against it here would make the test
      // fail specifically BECAUSE it's running in CI, which is backwards.
      // What must never fire on real darwin bare metal, CI or not, is the
      // container/codex/anthropic-sandbox-runtime family.
      const result = detectSandbox()
      for (const s of result.detail) expect(s.kind).toBe('ci')
      for (const s of result.signals) {
        expect(s).not.toMatch(/^container:/)
        expect(s).not.toMatch(/^codex:/)
        expect(s).not.toMatch(/^anthropic-sandbox-runtime:/)
      }
    })

    it('a read that throws after existsSync says yes (race/permission) fails closed, not throws', () => {
      const p = probe({
        existsSync: (path) => path === '/proc/1/cgroup',
        readFileSync: () => {
          throw new Error('EACCES: permission denied')
        },
      })
      expect(() => detectContainer(p)).not.toThrow()
      expect(detectContainer(p)).toEqual([])
    })
  })

  describe('Docker/container detection', () => {
    it('fires on /.dockerenv', () => {
      const p = probe({ existsSync: (path) => path === '/.dockerenv' })
      const signals = detectContainer(p)
      expect(signals).toHaveLength(1)
      expect(signals[0]).toMatchObject({ kind: 'container', confidence: 'high' })
      expect(signals[0].detail).toContain('/.dockerenv')
    })

    it('fires on a docker cgroup marker', () => {
      const p = probe({
        existsSync: (path) => path === '/proc/1/cgroup',
        readFileSync: (path) => (path === '/proc/1/cgroup' ? '0::/docker/abc123\n' : ''),
      })
      const signals = detectContainer(p)
      expect(signals).toHaveLength(1)
      expect(signals[0].confidence).toBe('high')
    })

    it('fires on a kubepods cgroup marker', () => {
      const p = probe({
        existsSync: (path) => path === '/proc/1/cgroup',
        readFileSync: () => '0::/kubepods/burstable/pod123/container456\n',
      })
      expect(detectContainer(p)).toHaveLength(1)
    })

    it('fires on KUBERNETES_SERVICE_HOST', () => {
      const p = probe({ env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' } })
      const signals = detectContainer(p)
      expect(signals).toHaveLength(1)
      expect(signals[0].detail).toContain('KUBERNETES_SERVICE_HOST')
    })

    it('a non-container cgroup file does not fire', () => {
      const p = probe({
        existsSync: (path) => path === '/proc/1/cgroup',
        readFileSync: () => '0::/user.slice/user-1000.slice\n',
      })
      expect(detectContainer(p)).toEqual([])
    })

    it('combines multiple markers into multiple signals', () => {
      const p = probe({
        existsSync: (path) => path === '/.dockerenv' || path === '/proc/1/cgroup',
        readFileSync: () => '0::/docker/abc\n',
      })
      expect(detectContainer(p)).toHaveLength(2)
    })
  })

  describe('Anthropic sandbox-runtime detection', () => {
    it('fires at low confidence on SANDBOX_RUNTIME=1', () => {
      const p = probe({ env: { SANDBOX_RUNTIME: '1' } })
      const signals = detectAnthropicSandboxRuntime(p)
      expect(signals).toHaveLength(1)
      expect(signals[0]).toMatchObject({ kind: 'anthropic-sandbox-runtime', confidence: 'low' })
    })

    it('does not fire on unrelated or falsy values', () => {
      expect(detectAnthropicSandboxRuntime(probe({ env: { SANDBOX_RUNTIME: '0' } }))).toEqual([])
      expect(detectAnthropicSandboxRuntime(probe({ env: {} }))).toEqual([])
    })
  })

  describe('Codex sandbox detection', () => {
    it('fires at high confidence on CODEX_SANDBOX_NETWORK_DISABLED=1', () => {
      const p = probe({ env: { CODEX_SANDBOX_NETWORK_DISABLED: '1' } })
      const signals = detectCodexSandbox(p)
      expect(signals.some(s => s.detail.includes('CODEX_SANDBOX_NETWORK_DISABLED') && s.confidence === 'high')).toBe(true)
    })

    it('fires at high confidence on the documented macOS value CODEX_SANDBOX=seatbelt', () => {
      const p = probe({ env: { CODEX_SANDBOX: 'seatbelt' } })
      const signals = detectCodexSandbox(p)
      expect(signals).toHaveLength(1)
      expect(signals[0].confidence).toBe('high')
    })

    it('fires at medium confidence on an undocumented CODEX_SANDBOX value (e.g. a Linux landlock value)', () => {
      const p = probe({ env: { CODEX_SANDBOX: 'landlock' } })
      const signals = detectCodexSandbox(p)
      expect(signals).toHaveLength(1)
      expect(signals[0].confidence).toBe('medium')
    })

    it('does not fire when neither var is set', () => {
      expect(detectCodexSandbox(probe())).toEqual([])
    })
  })

  describe('generic CI detection', () => {
    it('fires at low confidence on CI=true', () => {
      const signals = detectCI(probe({ env: { CI: 'true' } }))
      expect(signals).toHaveLength(1)
      expect(signals[0].confidence).toBe('low')
    })

    it('fires on CI=1 too', () => {
      expect(detectCI(probe({ env: { CI: '1' } }))).toHaveLength(1)
    })

    it('does not fire on CI=false or unset', () => {
      expect(detectCI(probe({ env: { CI: 'false' } }))).toEqual([])
      expect(detectCI(probe())).toEqual([])
    })
  })

  describe('combined detectSandbox', () => {
    it('reports sandboxed:true with the docker signal and high confidence', () => {
      const p = probe({ existsSync: (path) => path === '/.dockerenv' })
      const result = detectSandbox(p)
      expect(result.sandboxed).toBe(true)
      expect(result.confidence).toBe('high')
      expect(result.signals).toEqual(['container: /.dockerenv'])
    })

    it('picks the highest confidence across mixed signals', () => {
      const p = probe({
        env: { CI: 'true' },
        existsSync: (path) => path === '/.dockerenv',
      })
      const result = detectSandbox(p)
      expect(result.confidence).toBe('high') // docker beats CI's low
      expect(result.signals).toHaveLength(2)
    })

    it('never reports false — nothing detected is unknown, not false', () => {
      expect(detectSandbox(probe()).sandboxed).toBe('unknown')
    })
  })

  describe('sandboxSuggestion (print-only, keel status wiring)', () => {
    it('produces the exact suggestion shape for a docker detection', () => {
      const p = probe({ existsSync: (path) => path === '/.dockerenv' })
      const text = sandboxSuggestion(detectSandbox(p))
      expect(text).toContain('sandbox detected (docker via /.dockerenv)')
      expect(text).toContain('Tier-2 prompts could relax to warns')
      expect(text).toContain('keel level sprint --project')
      expect(text).toContain('per-rule overrides')
      expect(text).toContain('keel never applies this automatically')
    })

    it('is null when detection is unknown (nothing fired)', () => {
      expect(sandboxSuggestion(detectSandbox(probe()))).toBeNull()
    })

    it('picks the highest-confidence signal as the headline when several fired', () => {
      const p = probe({
        env: { CI: 'true' },
        existsSync: (path) => path === '/.dockerenv',
      })
      const text = sandboxSuggestion(detectSandbox(p))
      expect(text).toContain('docker via /.dockerenv')
      expect(text).not.toContain('ci via')
    })
  })
})
