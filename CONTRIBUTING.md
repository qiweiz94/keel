# Contributing to Keel

## Getting Started

```bash
git clone https://github.com/qiweiz94/keel.git
cd keel
npm install
npm run build
```

## Development Workflow

1. Create a branch: `git checkout -b feature/my-feature`
2. Make your changes
3. Run tests: `npm test`
4. Run lint: `npm run lint`
5. Push and open a PR

## Code Standards

- TypeScript strict mode
- No `any` types
- Tests for all new features
- Clear error messages (users should know what was blocked and why)

## Adding a Guard Rule

Rules are plain YAML (`.keel/rules.yaml` / `~/.keel/rules.yaml` — see the
README "Rules" section for the schema).

1. Extend rule parsing if you add a new rule field: `packages/core/src/enforce/rule-parser.ts`
2. Implement evaluation in the enforcement pipeline: `packages/core/src/enforce/pipeline.ts`
3. Add rule semantics/types in `packages/core/src/types.ts`
4. Write tests in `packages/core/src/__tests__/` and `packages/cli/src/__tests__/`
5. Update the README and docs/integration-guides/

## Adding an Integration

1. Create a guide in `docs/integration-guides/`
2. Add configuration examples for the AI coding assistant
3. Test the integration end-to-end
4. Submit a PR with the guide and any needed code changes

## PR Guidelines

- Title: `type(scope): description` (e.g., `feat(cli): add --json output flag`)
- Description: What the change does and why
- Tests: Include tests for new functionality
- Documentation: Update README or docs if changing behavior
