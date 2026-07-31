---
keel:
  version: 1
  level: balanced
  rules:
    - id: product-name-is-keel
      type: command
      match: "(sed|replaceAll|rename).*(keel|product.name)?.*(ai-enforce|ai_enforce)"
      action: deny
      level: sprint
      priority: 100
      message: "Product name is 'keel'. If you need to change it, update the rule first."

    - id: no-force-push
      type: command
      match: "git push --force(?!-with-lease)"
      action: deny
      level: sprint
      message: "Use --force-with-lease instead of --force."

    - id: no-destructive-commands
      type: command
      match: "rm -rf /|rm -rf ~"
      action: deny
      level: sprint
      message: "Destructive commands are blocked."

    - id: no-git-bypass
      type: command
      match: "git.*--no-verify|core\\.hooksPath"
      action: deny
      level: sprint
      message: "Git hook bypass is not allowed."

    - id: must-sign-commits
      type: command
      match: "git commit"
      action: fix
      fix:
        - pattern: "git commit"
          replace: "git commit --signoff"
      level: sprint
      message: "Auto-adding --signoff to commits."

    - id: re-inject-rules
      type: context
      level: sprint
      message: "Re-inject rules at 8K/16K/32K token thresholds."

    - id: verify-before-claim
      type: sequence
      steps:
        - tool: WriteFile
          pattern: "src/"
        - tool: edit
          pattern: "src/"
      sequence_window_seconds: 300
      action: deny
      level: sprint
      priority: 90
      message: "After changing source code, you must run npm test. Build is not sufficient verification."

    - id: test-after-build
      type: sequence
      steps:
        - tool: Bash
          pattern: "npm run build|tsc|vite build"
      sequence_window_seconds: 120
      action: deny
      level: sprint
      priority: 90
      message: "Build success does not mean tests pass. Run npm test and confirm all green before reporting done."

    - id: verify-format-before-decision
      type: command
      match: "(default|choose).*(format|config|rule)"
      action: warn
      level: sprint
      unless_reasoning: "user.*(said|asked|want|use|prefer)|verify|check|ask"
      message: "You are choosing a format without verifying the user's actual setup. Ask what they use before deciding."

    - id: evidence-before-done
      type: command
      match: "(done|fixed|complete|working)"
      action: deny
      level: sprint
      unless_reasoning: "test.*pass|verified|confirmed.*output|evidence"
      message: "Don't claim completion without evidence. Include test output, verification steps, or concrete proof."

    - id: no-rename-product-name
      type: command
      match: "replaceAll.*(keel).*(ai-enforce|ai_enforce)"
      action: deny
      level: sprint
      priority: 100
      message: "Product name is keel. If you need to change it back, update the rule first."
---

# Keel — project rules for building Keel itself

## Core lessons from session 2026-07-29
- **Verify before claiming done**: Running `npm run build` is NOT verification. Tests must pass.
- **Ask before defaulting**: Never choose a format/config without verifying what the user uses.
- **Evidence required**: "Done" means tests passed + output shown, not "I believe it works."
- **Standing requirements**: Re-check user's stated requirements at 8K/16K/32K — they were said early and degrade.

## Product name
- The product name is **keel**. Never change it to `ai-enforce` or any other name.
- All references in code, docs, configs, and commands must use `keel`.
- Before running `replaceAll` or `sed` with product names, verify direction: code → spec, not spec → code.

## Git
- NEVER use `git push --force` — use `--force-with-lease` instead.
- ALWAYS sign commits with `--signoff`.
- NEVER bypass git hooks.

## Verification
- ALWAYS run `npm test` (not just `npm run build`) before claiming a fix is done.
- At 16K+ tokens, re-read the user's standing requirements — they were stated early in the conversation.
- Any claim of completion must include evidence (test output, confirmation, proof).

## General
- No destructive commands (`rm -rf /`, `rm -rf ~`).
- Protect `.env`, credentials, tokens, and key files.
- If unsure about a format or convention, ask the user before deciding. Do not default.
