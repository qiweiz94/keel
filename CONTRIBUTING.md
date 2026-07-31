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

1. Define the rule types in `packages/core/src/types.ts`
2. Implement the evaluation logic in `packages/core/src/policy-engine.ts`
3. Add default rules in `packages/core/src/policy-engine.ts` (defaultPolicy method)
4. Add the new rule type to the CLI check command
5. Write tests
6. Update the README

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
