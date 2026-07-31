#!/bin/bash
# Publish Keel packages to npm.
#
# Usage:
#   bash scripts/publish.sh                 # interactive OTP prompt
#   KEEL_NPM_OTP=123456 bash scripts/publish.sh
#
# Packages (publish order matters — nothing depends on a published package,
# but the plugin build copies the canonical template from this repo):
#   1. @keel/core              — enforcement engine
#   2. keel-cli                — CLI (binary name: keel)
#   3. @keel/opencode-plugin   — OpenCode plugin (builds from templates/)
#   4. @keel/mcp-server        — deprecated MCP server
#
# Notes:
#   - The npm name "keel" is taken by teamkeel; the CLI publishes as "keel-cli".
#   - Each package is built before publishing.
set -euo pipefail

OTP="${KEEL_NPM_OTP:-}"
if [ -z "$OTP" ]; then
  read -r -p "npm 2FA code: " OTP
fi

echo "Building all packages..."
npm run build

publish() {
  local dir="$1"
  local pkg="$2"
  echo ""
  echo "Publishing $pkg from $dir ..."
  (cd "$dir" && npm publish --access public --otp="$OTP")
}

publish packages/core "@keel/core"
publish packages/cli "keel-cli"
publish packages/opencode-plugin "@keel/opencode-plugin"
publish packages/mcp-server "@keel/mcp-server"

echo ""
echo "✅ All packages published!"
echo ""
echo "Test: npm install -g keel-cli && keel --version"
echo "Plugin: add \"@keel/opencode-plugin\" to opencode.json, or run: keel install --opencode"
