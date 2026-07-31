#!/bin/bash
# Publish Keel packages to npm.
#
# Usage (choose ONE auth method):
#   bash scripts/publish.sh                          # interactive OTP prompt
#   KEEL_NPM_OTP=123456 bash scripts/publish.sh      # OTP via env
#   NODE_AUTH_TOKEN=npm_xxx bash scripts/publish.sh  # granular token (bypass2FA or CI)
#
# Packages (publish order matters — nothing depends on a published package,
# but the plugin build copies the canonical template from this repo):
#   1. @keel/core              — enforcement engine
#   2. keel-cli                — CLI (binary name: keel)
#   3. @keel/opencode-plugin   — OpenCode plugin (builds from templates/)
#
# @keel/mcp-server is intentionally NOT published — it is deprecated
# (use `keel serve` instead) and not part of the v1 launch.
set -euo pipefail

OTP="${KEEL_NPM_OTP:-}"
if [ -z "$OTP" ] && [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  read -r -p "npm 2FA code: " OTP
fi

echo "Building all packages..."
npm run build

publish() {
  local dir="$1"
  local pkg="$2"
  echo ""
  echo "Publishing $pkg from $dir ..."
  if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
    # Token path: pass as a CLI flag so it overrides any token already in
    # ~/.npmrc (npm prefers .npmrc over NODE_AUTH_TOKEN).
    (cd "$dir" && npm publish --access public --//registry.npmjs.org/:_authToken="$NODE_AUTH_TOKEN")
  else
    (cd "$dir" && npm publish --access public --otp="$OTP")
  fi
}

publish packages/core "@keel/core"
publish packages/cli "keel-cli"
publish packages/opencode-plugin "@keel/opencode-plugin"

echo ""
echo "✅ All packages published!"
echo ""
echo "Test: npm install -g keel-cli && keel --version"
echo "Plugin: add \"@keel/opencode-plugin\" to opencode.json, or run: keel install --opencode"
