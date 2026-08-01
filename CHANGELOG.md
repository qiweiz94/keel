# Changelog

## Unreleased

## 0.1.5 (2026-08-01)

First public release of the `@get-keel/*` packages (`@get-keel/core`,
`@get-keel/cli`, `@get-keel/opencode-plugin`). Includes the enforcement
security hardening below.

**Security.** Real-time enforcement did not work in any prior (pre-public)
version. If you installed the Claude Code PreToolUse hook or the Cline plugin
from an earlier release, treat everything they reported as unverified — see
[docs/enforcement-audit-2026-07-28.md](docs/enforcement-audit-2026-07-28.md).

### Fixed — enforcement

- **The Claude Code PreToolUse hook allowed every tool call**, including
  `rm -rf /`. It parsed the payload for `"tool"`/`"filePath"` while Claude Code
  sends `tool_name`/`tool_input`/`file_path`, so it never matched and fell
  through to `allow`. It also failed *open* on a missing binary, on any crash,
  and on any command containing an escaped quote. Now parses with a real JSON
  parser, emits the documented nested response, and denies on every error path.
- **The hook's settings template could never fire it** — `"matcher": "Bash(*)"`
  is the permissions grammar and an invalid regex. `Write` was also missing.
- **`init --hooks` made repositories uncommittable.** An advisory
  edit-before-read *warning* counted as a violation, so `check --ci` exited 1 for
  every staged file and the installed pre-commit hook rejected every commit.
- **`init --hooks` destroyed existing git hooks.** It now preserves the previous
  hook and chains it; that hook's failure still fails the commit.
- **A malformed or empty policy file silently reverted to weaker defaults**, or
  crashed the CLI, which the hook converted to `allow`. Absent file ⇒ defaults;
  present but broken ⇒ fail closed.
- **Nothing protected the enforcement configuration.** Added a default rule
  covering `.ai-enforce.yaml`, `.ai-enforce/`, `.claude/settings.json`,
  `.git/hooks/`.
- **Shell injection in `autoVerify`** via an interpolated file path. Now
  `execFileSync` with argv, and actually wired into `check` — it previously had
  no callers at all.
- **Globs with a non-leading `**` matched nothing**, so rules and excludes users
  believed were active did nothing.
- **A blocked command exited 0**, and one invalid regex in a policy disabled all
  enforcement.
- **The Cline plugin failed open by design** and shelled out with the command it
  was policing. Rewritten: argv-based and fail-closed.
- `install.sh` masked npm failure and reported success regardless.

### Fixed — evidence

- **No action receipt had ever been written.** `createSign('ed25519')` throws
  (Ed25519 takes no digest name) and the error was swallowed. `verify` also
  could not load its key, reporting every receipt invalid.
- **The audit hash chain reset every process**, so no entry linked to another and
  deletion was undetectable. It now persists across runs, and `verify` checks
  linkage — not just per-entry signatures. Pre-upgrade logs are recognised and
  not reported as tampered.
- `verify` no longer silently checks only the last 100 receipts.
- Private signing keys are written `0600`.

### Changed

- `@get-keel/core` is now the single source of truth; the CLI's forked engine
  is a re-export. **Publishing order matters: core first, then the CLI** — the
  release workflow and `scripts/publish.sh` already do this.
- `packages/mcp-server` added to workspaces — it previously could not build.
- New `check --file <path> --write` evaluates write rules; the CLI could
  previously only ask about reads.
- Tests are no longer compiled into published packages.

### Added

- 102 new tests covering the shipped enforcement path, the hook contract, the
  evidence chain, and detector evasion. CI's `npm test` step had been failing
  since tests were introduced, because the CLI path was resolved from
  `process.cwd()`.

### Release hardening

- Deterministic enforcement coverage for the supported rule types.
- Persistent state, one-time overrides, live rule reload, kill-switch safety,
  audit redaction, and release tarball verification.
- The MCP server remains private and deprecated; it is not published.

## 0.1.0 (2026-07-28)

Initial alpha release.

### Features
- **CLI**: `ai-enforce init`, `check`, `audit` commands
- **Git hook protection**: Blocks `--no-verify`, `core.hooksPath` overrides, git hook bypass
- **File protection**: Blocks reads/writes to `.env`, credentials, private keys
- **Command protection**: Blocks destructive commands (`rm -rf /`, `sudo`, `pkill -f python`)
- **Secret detection**: Detects API keys, tokens, credentials in files and shell commands
- **API key exposure guard**: Detects `echo $KEY`, `cat .env`, `env | grep` patterns
- **Edit-before-read enforcement**: Warns when editing files without reading them first
- **Auto-verify**: Syntax checks Python, JSON, and shell files after edits
- **MCP enforcement server**: Real-time policy checking via Model Context Protocol
- **Session tracking**: Tracks read files and events across a session
- **Audit log**: Append-only JSONL log with timestamps and rule details
- **--ci mode**: Check staged git changes against policy

### Integrations
- Cline (MCP server)
- Claude Code (MCP server + PreToolUse hooks)
- Cursor (MCP server)
- Aider (git hooks)
- GitHub Copilot (git hooks + GitHub Action)

### Limitations (alpha)
- MCP server provides policy checking tools (not a full forwarding proxy)
- HTTP proxy mode available experimentally
- Windows support pending
