#!/bin/bash
# keel working demo
# Shows the tool blocking dangerous commands in real-time
set -euo pipefail

echo "╔══════════════════════════════════════════════════════════╗"
echo "║           keel — Live Demo                        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Create temp directory for demo
DEMO_DIR=$(mktemp -d)
cd "$DEMO_DIR"
git init

echo "📦 Setting up keel..."
if ! command -v keel &>/dev/null; then
  echo "Error: keel not installed. Run: npm install -g keel-cli"
  exit 1
fi
keel init --hooks 2>/dev/null || true

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "DEMO 1: Block destructive command"
echo "═══════════════════════════════════════════════════════════"
echo '$ keel check --command "rm -rf /"'
keel check --command "rm -rf /"
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "DEMO 2: Block git hook bypass"
echo "═══════════════════════════════════════════════════════════"
echo '$ keel check --command "git commit --no-verify -m test"'
keel check --command "git commit --no-verify -m test"
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "DEMO 3: Block sudo usage"
echo "═══════════════════════════════════════════════════════════"
echo '$ keel check --command "sudo rm file"'
keel check --command "sudo rm file"
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "DEMO 4: Block API key exposure"
echo "═══════════════════════════════════════════════════════════"
echo '$ keel check --command "echo \$OPENAI_API_KEY"'
keel check --command 'echo $OPENAI_API_KEY'
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "DEMO 5: Allow safe command"
echo "═══════════════════════════════════════════════════════════"
echo '$ keel check --command "npm install express"'
keel check --command "npm install express"
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "DEMO 6: Detect secrets in file"
echo "═══════════════════════════════════════════════════════════"
echo 'sk_test_abc123' > secrets.txt
echo '$ cat secrets.txt'
echo 'sk_test_abc123'
echo '$ keel check secrets.txt'
keel check secrets.txt 2>&1 || true
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "DEMO 7: Audit log"
echo "═══════════════════════════════════════════════════════════"
echo '$ keel audit --tail 10'
keel audit --tail 10
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "✅ All demos complete!"
echo ""
echo "What you just saw:"
echo "  • 6 different enforcement guards working"
echo "  • Real-time blocking (pre-execution via CLI)"
echo "  • Persistent audit log"
echo ""
echo "For Claude Code PreToolUse (real-time hook):"
echo "  bash docs/hooks/claude-code-setup.sh"
echo ""
echo "For Cline plugin (real-time enforcement):"
echo "  mkdir -p .opencode/plugins/"
echo "  cp docs/hooks/cline-plugin.mjs .opencode/plugins/keel.mjs"
echo "═══════════════════════════════════════════════════════════"

cd /tmp
rm -rf "$DEMO_DIR"
