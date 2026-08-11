# Wave 1 Lane 7 — Legacy Bug Verification

## BUG (a) — ESM require() crash in lessons command

**Reported Issue**: packages/cli/src/commands/lessons.ts used `require('node:fs')` in an ESM package and crashed at runtime.

**Current Status**: FIXED

**Evidence**:

The lessons.ts file uses proper ESM imports:
```
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
```

Test run (lessons --help):
```
Usage: keel lessons [options]

Extract self-improvement lessons from audit logs

Options:
  --since <date>     Analyze from date (YYYY-MM-DD)
  --apply <pattern>  Generate rule YAML for a specific lesson pattern
  --list             List saved lessons
  -h, --help         display help for command
```

**Verdict**: FIXED — The built CLI's lessons command loads and displays help without crashing. ESM imports are correct.

**Repro Command**: 
```bash
node packages/cli/bin/keel.js lessons --help
```

---

## BUG (c) — State reset on subprocess boundary prevents warn→deny escalation

**Reported Issue**: Each `keel evaluate` subprocess had its own in-memory state, so warn-first-time state never persisted across calls. The warn→deny escalation ladder could never reach deny through the subprocess path.

**Current Status**: FIXED (via StateManager disk persistence + KEEL_STATE_DIR env var support)

**Root Cause**: StateManager was implemented with disk persistence (state-manager.ts, lines 30-157) but did not support the KEEL_STATE_DIR environment variable. This meant state was saved to ~/.keel/state by default, which could be inadvertently used across different test/CLI environments.

**Fix Applied**: Added KEEL_STATE_DIR env var support to StateManager:
```typescript
const STATE_DIR = process.env.KEEL_STATE_DIR || join(homedir(), '.keel', 'state')
```

**Evidence**: Two-call test with shared KEEL_STATE_DIR

Test setup:
- Temp project with .keel/rules.yaml containing one deny rule (balanced level, no protect)
- Temp KEEL_STATE_DIR for isolation
- Temp HOME to avoid loading global ~/.keel/rules.yaml

First call (subprocess 1):
```json
{
  "action": "warn",
  "rule_id": "test-deny-escalation",
  "message": "First violation of \"test-deny-escalation\" — warning only. Next time will be blocked.",
  "rule_name": "test-deny-escalation"
}
```

Second call (subprocess 2, same KEEL_STATE_DIR):
```json
{
  "action": "deny",
  "rule_id": "test-deny-escalation",
  "message": "Test rule for deny escalation verification",
  "rule_name": "test-deny-escalation"
}
```

State files persisted on disk:
- `/tmp/test-keel-state/deny-first-time.json` — tracks which rules have warned once
- `/tmp/test-keel-state/circuit-breaker.json` — tracks circuit breaker counts

**Verdict**: FIXED — The escalation chain warn→deny now works correctly across process boundaries via StateManager disk persistence.

**Repro Commands**:
```bash
# Setup
TEST_PROJECT="/path/to/test/project"
TEST_KEEL_STATE=$(mktemp -d)
TEST_HOME=$(mktemp -d)

# Create test rules
mkdir -p "$TEST_PROJECT/.keel"
cat > "$TEST_PROJECT/.keel/rules.yaml" << 'EOF'
keel:
  version: 1
  config:
    level: balanced
  rules:
    - id: test-deny-escalation
      type: command
      match: "test-command"
      action: deny
      message: "Test rule for deny escalation verification"
      priority: 50
EOF

# First call (warns)
export KEEL_STATE_DIR="$TEST_KEEL_STATE"
export HOME="$TEST_HOME"
node packages/cli/bin/keel.js evaluate \
  --tool Bash \
  --args '{"command":"test-command"}' \
  --level balanced \
  --cwd "$TEST_PROJECT"

# Second call (denies)
node packages/cli/bin/keel.js evaluate \
  --tool Bash \
  --args '{"command":"test-command"}' \
  --level balanced \
  --cwd "$TEST_PROJECT"
```

Expected output: First call action=warn, second call action=deny.

---

## Summary

- **BUG (a)**: FIXED — No require() in lessons.ts, proper ESM imports throughout
- **BUG (c)**: FIXED — State persists across subprocess boundary via StateManager + KEEL_STATE_DIR env var support
- **Code Changes**: Added KEEL_STATE_DIR support to packages/core/src/enforce/state-manager.ts (one-liner)
- **Build**: Project builds successfully after changes (`npm run build`)
