# Keel — project guide

Keel enforces rules on AI coding agents OUTSIDE the agent's context window.

## Build & Test

```bash
npm run build                    # Build all packages
npm run test -w @get-keel/core       # Core tests (82 passing)
npm run test -w @get-keel/cli        # CLI tests (158 passing)
npm run test -w @get-keel/opencode-plugin  # Plugin load tests
keel validate                    # Check rules
```

## Architecture

```
packages/
├── core/              @get-keel/core      — Enforcement pipeline, state, audit
├── cli/               @get-keel/cli — CLI binary (`keel`) + OpenCode plugin
├── opencode-plugin/   @get-keel/opencode-plugin — npm package for plugin
└── mcp-server/        @get-keel/mcp-server — (deprecated)
```

## Running locally

```bash
node packages/cli/bin/keel.js validate
node packages/cli/bin/keel.js evaluate --tool Bash --args '{"command":"ls"}'
```

After `npm link`: just `keel validate`.

## Plugin architecture

The OpenCode plugin has one implementation source and generated delivery files:

```
packages/opencode-plugin/src/plugin.ts   ← implementation source
packages/cli/templates/keel-enforce.js   ← generated install artifact
```

It is consumed by:
- `keel install --opencode`  → copies to `~/.opencode/plugins/keel-enforce.js`
- `keel install --project`   → copies to `<project>/.opencode/plugins/keel-enforce.js`
- `@get-keel/opencode-plugin`    → build script copies it to `dist/index.js` verbatim

The plugin build bundles the shared core semantics into both `dist/index.js`
and the CLI template. NEVER edit generated artifacts directly; edit
`packages/opencode-plugin/src/plugin.ts` or shared core sources and re-run the
build.

Hooks implemented (SPEC.md §6):
- `tool.execute.before` — deny/warn/fix every tool call, plus sequence-rule
  detection (forbidden step orders within a sliding window, mirroring
  `core/src/enforce/sequencer.ts`); first violation of a deny rule warns,
  repeat denies; state persists across restarts
- `tool.execute.after` — records successful verification commands (`metadata.exit === 0`)
- `experimental.chat.system.transform` — injects `~/.keel/requirements.md` and
  `<project>/.keel/requirements.md` into the system prompt every turn
- `experimental.session.compacting` — embeds requirements in compaction context

## Plugin format

OpenCode plugins auto-loaded from `.opencode/plugins/*.js` must use the V1
format with an explicit `id` (OpenCode throws "Path plugin must export id"
without it — the `export const` style from the OpenCode docs is the legacy
format and does NOT provide an id):

```javascript
export default {
  id: "keel-enforce",              // Required for file plugins
  server: async () => {            // Required — called by OpenCode
    return {
      'tool.execute.before': async (input, output) => { ... },
    }
  },
}
```

Auto-load gotchas:
- Only `*.ts` / `*.js` files load from plugin directories — `.mjs` is ignored
- `--pure` flag disables all external plugins
- `opencode run` (headless) and `opencode serve` load server-kind plugins;
  the TUI loads them too (in its worker process)

## Standing requirements

- OpenCode is the primary agent. Use AGENTS.md for instructions. Never CLAUDE.md.
- Before claiming "done": run `npm test`, include output as evidence.
- Build success ≠ tests pass. Run both.
- When choosing a format/convention: ask the user. Never default.
- Product name is "keel". Never "ai-enforce".
- Before proposing a plan: identify root causes it does NOT address.
- Be honest about what you've verified vs what you haven't tested.
- At 16K+ tokens, re-check standing requirements — they degrade from context.

## Publishing

```bash
# Run the validated release workflow by pushing tag v<cli-version>.
# Local preflight: npm ci && npm audit && npm run build && npm test
# Never publish MCP; packages/mcp-server is private and deprecated.
```

## Standing requirements (for Keel itself)

### Verification culture
- Before ANY "done" claim: run `npm run build` AND `npm run test -w @get-keel/core`
- Include test output as evidence in the response
- List what was changed and how each change was verified
- A compile check is NOT verification. Tests must pass.

### Format decisions
- OpenCode is the primary agent. Use AGENTS.md for agent instructions.
- Never write to CLAUDE.md. OpenCode doesn't use it.
- When choosing a format, ask the user what they use. Never default.

### Plan quality
- Before proposing a plan, identify what root causes it does NOT address.
- Distinguish between bug fixes (patch symptoms) and root-cause fixes.
- Be honest about what you have verified vs what you haven't tested.

### Product identity
- Product name is "keel". Never "ai-enforce" or any other name.
- Before any rename/sed/replaceAll operation: verify the direction.

### Irreversible operations
- Before recommending or executing an IRREVERSIBLE action (repo deletion, npm publish/unpublish, force push, data deletion), enumerate inbound references: npm registry metadata, README badges, CI links, forks, issues, other repos.
- For irreversible actions the burden of proof is higher: keep unless there is proven harm, not "no harm found in what I checked."
- Check INBOUND references (what points to the target), not just outbound (what the target points to).
- State explicitly what was verified vs assumed before acting irreversibly.
