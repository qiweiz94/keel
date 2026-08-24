/**
 * Whether keel is running for a real human at a terminal, as opposed to CI,
 * an agent's non-TTY shell, or a test harness driving the command
 * programmatically.
 *
 * This is the ONE gate every command with a user-environment side effect —
 * auto-opening a browser, an interactive keypress loop, a human-only
 * mutation of the user's rules — must check before firing. It mirrors
 * dashboard-web.ts's `shouldAutoOpenBrowser()`, the reference gate for the
 * browser-flood regression: `keel dashboard --web` opening a tab on every
 * `npm test` run because the open was gated on nothing but
 * `platform === 'darwin'`. A side effect that fires in automation is a
 * trust bug, not a convenience — see no-side-effects.test.ts for the
 * invariant this pins across every command, not just this one.
 *
 * Individual commands may still layer their own opt-in escape hatch on top
 * (e.g. `KEEL_ALLOW_NON_TTY=1`, `KEEL_NO_OPEN=1`) for tests and for users
 * who explicitly want the behavior anyway — this function only answers
 * "is anyone actually watching a terminal right now."
 */
export function isInteractive(): boolean {
  return !!process.stdin.isTTY && !process.env.CI
}
