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
