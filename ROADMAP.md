# Keel Roadmap

## Current State (v0.1.5)

### Implemented (10 CLI commands)

| Command | Purpose | Status |
|---------|---------|--------|
| `init` | Create policy + install git hooks | ✅ |
| `check` | Check commands/files/policies against rules | ✅ |
| `audit` | View signed enforcement audit log | ✅ |
| `serve` | MCP enforcement server (policy checking tools) | ✅ |
| `template` | 4 pre-built policy templates | ✅ |
| `rules` | Import ATR detection rules (10 categories, 3 lanes) | ✅ |
| `scan` | Auto-detect 12+ AI coding assistants + MCP configs | ✅ |
| `verify` | Verify Ed25519-signed action receipts | ✅ |
| `gateway` | MCP security gateway (bidirectional proxy + scanning) | ✅ |
| `policy` | Rego/WASM policy engine | ✅ |

### Enforcement Guards (10)

- Destructive commands (rm -rf /, sudo, pkill)
- Git hook bypass (--no-verify, core.hooksPath, MCP API writes)
- Force-push (unsafe)
- Secret file access (.env, credentials, *.pem)
- Git config access
- Secret detection (API keys, tokens, private keys)
- API key exposure via commands (echo, cat, curl Bearer)
- Edit-before-read warning
- API key exposure checks
- Behavioral anomaly detection (4 dimensions)

### Security Features

- Ed25519-signed audit entries (persistent keys, hash-chained)
- Signed action receipts (offline-verifiable evidence trail)
- MCP security gateway (input/output scanning, tool poisoning detection, DLP)
- Reasoning trace analysis (deception/override detection, +35% accuracy)
- Fail-closed guarantee (no policy = deny everything)
- Detection lanes (enforce/alert/hunt)
- File size limits (10MB) + binary file detection

### Code Quality

- 48 unit tests (all passing)
- 8 critical + 4 high bugs fixed
- Monorepo cleanup (package names, duplicated MCP server removed)
- Comprehensive comparison/documentation

---

## Next Steps (v0.2.0)

### Publish to npm

- [x] Prepare public v1 package metadata, audits, tarball checks, and release workflow
- [x] Set up GitHub Actions for automated publishing
- [ ] Add semantic release workflow

### Community Launch Prep

- [ ] Add animated demo GIF to README
- [ ] Write HN launch post outline
- [ ] Create Reddit r/programming post
- [ ] Set up Discord server
- [ ] Add GitHub issue templates
- [ ] Add GitHub Actions CI badge (currently broken)
- [ ] Publish `.pre-commit-hooks.yaml` to pre-commit registry

### Feature Gaps

- [ ] PreToolUse hooks for Cursor, Windsurf, GitHub Copilot (only Claude Code + Cline currently)
- [ ] Docker-based sandbox (`keel sandbox`)
- [ ] Formally prove security properties (conformance tests)
- [ ] 2,000+ community rules via Semgrep registry integration
- [ ] Turn gate (pre-inference prompt screening from Doberman)
- [ ] Privilege rings + trust scoring (from Microsoft AGT)
- [ ] OS-level seccomp/eBPF sandbox (from agentsh — lower priority)

### Testing

- [x] Add CLI package tests
- [ ] Add reasoning trace analysis tests
- [ ] Add anomaly detection tests
- [ ] Add MCP gateway tests
- [ ] Add receipt/signing tests
- [ ] Add Rego/WASM engine tests
- [ ] Add integration test for `keel init` + `keel check --ci`
- [ ] Windows path semantics in core matcher (normalize path separators; negated-path rule tests currently fail on Windows)
- [ ] Add MCP server integration test

### Known Issues

- `action: prompt` and `action: mask` are not supported in CLI (treated as `warn`)
- MCP gateway only supports stdio upstream (no HTTP/SSE yet)
- No CI/CD enforcement via native GitHub App
- No Homebrew formula for `brew install keel`
- Package versions are coordinated by `scripts/check-release.mjs`
