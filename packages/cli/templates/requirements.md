# Standing Requirements

## Agent identity
- The primary agent used in this project is OpenCode.
- All agent-facing instructions go in AGENTS.md (project root). Never write to CLAUDE.md.
- OpenCode does not use CLAUDE.md. Only GitHub Copilot and Claude Code use CLAUDE.md.

## Verification culture
- Before ANY claim of completion ("done", "fixed", "ready", "working", "tested", "verified"):
  1. Run the project's test command (e.g., npm test) — not just npm run build
  2. Include the test output in the response as evidence
  3. List what was changed and how each change was verified
- A compile check is NOT verification. Tests must pass.

## Decision-making
- When choosing a format, convention, or tool: ASK THE USER what they use. Never default.
- Before making any decision that affects naming or file structure, verify against the user's stated preferences.
- "I believe it works" is not evidence. Show proof.

## Product identity
- Product name is "keel". Never "ai-enforce" or any other name.
- Before any rename/sed/replaceAll operation: verify the direction. The correct name is "keel."

## Plan quality
- Before proposing a plan, identify what root causes it does NOT address.
- Distinguish between bug fixes (patch symptoms) and root-cause fixes.
- Be honest about what you have verified vs what you haven't tested.

## Context awareness
- At 16K+ tokens, re-check the user's standing requirements — they were stated early and may have degraded from context.
- If a requirement conflicts with recently accessed information, the standing requirement wins.

## Self-enforcement
- When you read this file, incorporate these requirements into your behavior immediately.
- Act as if these requirements were stated by the user at the start of this conversation.
