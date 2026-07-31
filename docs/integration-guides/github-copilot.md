# GitHub Copilot Integration

GitHub Copilot has no tool-interception hook, so Keel's Copilot integration is
**advisory**: instructions files remind the agent of your standing
requirements.

## Install

Copilot reads `.github/copilot-instructions.md` at session start. Point it at
your Keel standing requirements:

```markdown
<!-- .github/copilot-instructions.md -->
Follow the standing requirements in ~/.keel/requirements.md at all times:
- Before claiming completion, run the project's tests and include the output as evidence.
- Build success does not mean tests pass.
- Ask the user before choosing formats/configs. Never default.
- Re-check standing requirements in long sessions — early instructions degrade from context.
```

## How it works

```
Session start → .github/copilot-instructions.md → Keel standing requirements
```

Copilot cannot block tool calls. For hard enforcement use OpenCode (plugin) or
Claude Code (hooks).

## Requirements

- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
- Full standing requirements in `~/.keel/requirements.md`
