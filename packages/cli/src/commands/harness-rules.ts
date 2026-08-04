/**
 * The problem-solving rules — the half of keel that stops agents circling.
 *
 * keel has shipped `stuck`, `research` and `diagnosis` rule types since
 * Phase 2, but a fresh install writes none of them: the default
 * rules.yaml is destructive-command guards. So the anti-circling
 * machinery sits inert until someone pastes these in, and on this
 * machine's own traces that cost 41 distinct repeat loops across 20
 * sessions — one command retried 39 times.
 *
 * Emitted in `mode: observe` on purpose. These are behavioural rules with
 * no false-positive history on YOUR traffic yet, and a new rule that
 * interrupts on its first hit is how guardrails get switched off. Observe
 * records what it *would* have done; promote to `warn` or `block` once
 * `keel retrospective` shows the hit rate is real.
 */
export const HARNESS_RULES_YAML = `  # ── keel problem-solving harness ────────────────────────────────
  # Paste inside the top-level \`rules:\` list of ~/.keel/rules.yaml.
  #
  # All three ship as mode: observe — they record what they WOULD have
  # done without interrupting anything. Check the effect with
  #   keel retrospective --since <today>
  # then change mode to warn (surface it) or block (enforce it).

  - id: no-repeat-loops
    type: stuck
    match: "(npm|pnpm|yarn|bun)( run)? (test|build)|vitest|jest|pytest|go test|tsc|keel allow|git (commit|push)"
    mode: observe
    category: workflow
    severity: medium
    confidence: high
    window_seconds: 900
    max_attempts: 3
    fingerprint: auto
    require_failure: true
    reset_on_success: true
    escalation:
      - at: 3
        action: redirect
        message: "This exact command has failed 3 times in 15 minutes. Stop retrying it. Research the exact error, state a root-cause hypothesis, then change approach."
      - at: 5
        action: deny
        message: "5 identical failures. Retrying without new information is blocked — record a hypothesis or ask the user."
    action: warn
    rationale: >
      Identical retries against the same failure are the single clearest
      signal of a stuck agent, and the one thing a rule engine can see
      that the model cannot: it runs outside the context window, where
      circling actually lives.
    remediation: "Search the exact error, state a hypothesis, or ask the user."
    false_positives:
      - "Polling a long-running job by re-running the same status command"
    message: "Identical failing command repeated — research the error and change approach."

  - id: research-before-fix
    type: research
    mode: observe
    category: workflow
    severity: medium
    confidence: medium
    trigger:
      tools: [Bash]
      pattern: "(npm|pnpm|yarn|bun)( run)? (test|build)|vitest|jest|pytest|go test|tsc"
      exit: nonzero
    satisfy:
      tools: [Bash, WebSearch, WebFetch, websearch, webfetch, mcp__keel__keel_research]
      pattern: "(npm view|npm info|pip index|WebSearch|WebFetch|keel_research|keel_fetch)"
    boundaries:
      edit:
        pattern: "write|edit|apply_patch"
        action: redirect
    research_window_seconds: 600
    freshness_seconds: 1800
    action: redirect
    rationale: >
      Armed only by a FAILING command, never by green-field work — so it
      cannot slow down ordinary editing. It fires when a fix is about to
      be attempted against stale knowledge.
    remediation: "Look up the failing module or error before patching it."
    message: "A command just failed and you are about to patch it without checking current docs. Research the error first."

  - id: root-cause-before-refactor
    type: diagnosis
    mode: observe
    category: workflow
    severity: medium
    confidence: medium
    match: "(rm -rf|git checkout -- |git reset --hard|migrate|refactor)"
    require_hypothesis: true
    fallback_pattern: "git (log|blame|bisect|diff)"
    action: redirect
    rationale: >
      Complex or destructive fixes should follow an investigation, not
      precede one. Discharged by a recorded hypothesis OR by real
      investigation evidence (git log/blame/bisect/diff), so it never
      demands ceremony from someone who already did the work.
    remediation: "Run git log/blame/bisect, or record a hypothesis with keel_hypothesis."
    message: "Destructive or structural change without a recorded root cause. Investigate first."
`

export const HARNESS_RULE_IDS = ['no-repeat-loops', 'research-before-fix', 'root-cause-before-refactor']
