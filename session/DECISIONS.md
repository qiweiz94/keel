# session/DECISIONS.md — append-only decision log (v0.3 autonomous build)

- 2026-08-11 supervisor: Plan approved with 6 CTO amendments + §6 contract fix
  (dogfood via hook path, no TTY bypass in any shell). Canonical plan:
  ~/.claude/plans/we-are-working-off-cheerful-dusk.md
- 2026-08-11 supervisor: Wave 1 lane evidence goes to session/EVIDENCE/wave1-<lane>.md
  per lane; supervisor composes phase-0.md at the wave gate to avoid merge
  collisions in a shared file.
- 2026-08-11 supervisor: Lane branches w1-matchfix, w1-fixtures, w1-observed,
  w1-bugcheck in sibling worktrees; merged here at the gate.
- 2026-08-11 supervisor: Lane 7 found bug (c) only HALF-fixed — StateManager had disk
  persistence but ignored KEEL_STATE_DIR (silent fallback to real ~/.keel/state).
  Lane 7 applied the one-line env override (its mandate allowed one-liners proven by
  a failing test). Same character-identical line pushed to lanes 1/2/3 mid-flight so
  parallel duplicates merge cleanly. Gate check: line must appear exactly once after
  merge; re-run lane 7's two-subprocess warn→deny repro on the merged tree.
- 2026-08-11 supervisor: Lane 3 landed observed_action persistence (w1-observed 4e9e479).
  Scope correction accepted pending gate re-verification: receipts/signing are a SEPARATE
  legacy trail (SignedEntry, written by PolicyEngine.audit only; `keel verify` reads only
  that) — AuditEntry/traces compat tested against its real readers instead. Two gaps
  flagged for later waves: (1) MCP/daemon /v1/check writes NO AuditEntry at all
  (pre-existing); (2) traces dir (plugin TRACES_DIR + AuditLog default) has no env
  override — tests exercising the plugin hook directly would write real ~/.keel/traces.
  Assign both when Wave 2/3 lanes are cut. Lane 3 also reports 4 CLI level.test.ts
  ANSI/chalk failures that reproduce on the BASE commit — check in supervisor's own
  gate run before treating as pre-existing.
