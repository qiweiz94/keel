import { homedir } from 'node:os'

/**
 * Resolves the base "keel home" directory — the single root every
 * `.keel`/`.config/keel`/`.opencode`/etc. path is derived from, for BOTH
 * writers (`keel install`) and readers (daemon, rules, status,
 * state-manager, the opencode plugin, ...).
 *
 * Precedence: `KEEL_HOME` > `HOME` > `os.homedir()`.
 *   - `KEEL_HOME` is the explicit, keel-specific override for redirecting
 *     keel's entire footprint to a non-default location (a test run, a
 *     multi-user box, a sandboxed install). This is the override that
 *     closes the install/read split-brain: before this module existed,
 *     `install.ts` alone honored `KEEL_HOME` while every reader resolved
 *     a bare `homedir()` independently, so an install with `KEEL_HOME` set
 *     wrote to the redirected location while readers kept looking under
 *     the real home directory.
 *   - `HOME` is checked next, not left to `os.homedir()` alone, because
 *     `os.homedir()` ignores `$HOME` on Windows (it reads `USERPROFILE`
 *     instead) — several tests across this repo sandbox by setting
 *     `process.env.HOME` to a scratch directory, and relying on
 *     `os.homedir()` alone would silently un-sandbox those on
 *     `windows-latest` (see rule-parser.ts's original inline comment,
 *     now superseded by this function).
 *
 * MUST be called at the point of use, never cached in a module-level
 * const: several tests construct two instances of the same reader in one
 * process with a changed `KEEL_HOME`/`HOME`/`KEEL_STATE_DIR`-family var
 * between them and expect the second construction to observe the change
 * (see state-manager.test.ts, package-verifier.test.ts). The one
 * documented exception is the opencode plugin (packages/opencode-plugin/
 * src/plugin.ts), which has always computed its `.keel`-relative module
 * constants once at plugin-module-load time — callers of that plugin
 * (scripts/load-test.js) already set `HOME`/`KEEL_HOME` before importing
 * it, matching the plugin's existing load-once contract.
 */
export function resolveHome(): string {
  return process.env.KEEL_HOME || process.env.HOME || homedir()
}
