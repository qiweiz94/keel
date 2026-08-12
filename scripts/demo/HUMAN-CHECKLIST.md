# Demo — human checklist

`keel-disable-trace.sh` is fully scripted and runs unattended (it's a dry-run
against the real rule pipeline — no live agent, no LLM call, no network
access needed). What it does NOT do, and cannot do from inside an agent
session, is produce the actual GIF/video artifact used in the README,
landing page, or launch posts. That's a manual step. Checklist:

- [ ] Run `scripts/demo/keel-disable-trace.sh` in a clean terminal (not this
      one — resize/theme it first) at a width that keeps every line
      un-wrapped. 100–110 columns is a safe target for GitHub's README
      video-embed width.
- [ ] Use a terminal theme with a readable red/pass color for the `✗ DENY`
      and `prompt (...)` lines — the ANSI bold/dim codes are already in the
      script; a theme that renders `\033[1m` too faintly will bury the
      punchline.
- [ ] Record with `asciinema rec` (preferred — produces a scrubbable,
      copy-pasteable terminal recording, not just pixels) or a plain screen
      recorder if `asciinema` isn't available. Either way, do not speed up
      or trim the pauses between the two `keel test` calls — the beat
      between "blocked once" and "tries to disable keel, blocked again" is
      the whole point of the demo.
- [ ] Convert to GIF (`agg` for asciinema casts, or any screen-recording
      GIF export) and keep it under the file-size embed limit for wherever
      it's going (GitHub README inline embeds render fine well under 10MB;
      keep audio out entirely since GIF has none anyway).
- [ ] Drop the finished GIF at `docs/media/demo-disable-trace.gif` (create
      `docs/media/` if it doesn't exist) and link it from the README's demo
      section and `docs/landing.md`'s "Watch it block an agent" section —
      both currently link to the *script*, not a recording, until this step
      is done.
- [ ] Sanity-check the recording against a fresh run of the script right
      before recording — rules do get promoted/added over time (see
      `docs/tiers.md`'s rule count, which has already drifted once between
      the v0.4.0 and v1.0.0 releases), so a stale recording could show a
      verdict wording that no longer matches `keel test`'s live output.

Nothing above requires write access to this repo beyond adding the GIF
file and two links — it's deliberately scoped as a small, late, human-only
step so it doesn't gate the rest of the release.
