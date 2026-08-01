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
#   1. @get-keel/core              — enforcement engine
#   2. @get-keel/cli           — CLI (binary name: keel)
#   3. @get-keel/opencode-plugin   — OpenCode plugin (builds from templates/)
#
# @get-keel/mcp-server is intentionally NOT published — it is deprecated
# (use `keel serve` instead) and not part of the v1 launch.
set -euo pipefail

OTP="${KEEL_NPM_OTP:-}"
if [ -z "$OTP" ] && [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  read -r -p "npm 2FA code: " OTP
fi

echo "Building all packages..."
npm ci
npm audit --audit-level=moderate
npm run build
npm test
node scripts/check-packages.mjs
node scripts/check-tarballs.mjs
node scripts/check-release.mjs

publish() {
  local dir="$1"
  local pkg="$2"

  echo ""
  echo "Publishing $pkg from $dir ..."

  local out code
  # set -e would abort on the failed publish inside the substitution;
  # capture the status explicitly instead.
  set +e
  if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
    # Token path: pass as a CLI flag so it overrides any token already in
    # ~/.npmrc (npm prefers .npmrc over NODE_AUTH_TOKEN).
    out=$(cd "$dir" && npm publish --access public --//registry.npmjs.org/:_authToken="$NODE_AUTH_TOKEN" 2>&1)
  else
    out=$(cd "$dir" && npm publish --access public --otp="$OTP" 2>&1)
  fi
  code=$?
  set -e

  if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -q "cannot publish over the previously published versions"; then
    echo "  ✓ $pkg already published — skipping"
    return 0
  fi

  printf '%s\n' "$out"
  if [ "$code" -ne 0 ]; then
    echo "  ✗ Failed to publish $pkg (exit $code)"
    exit "$code"
  fi
}

publish packages/core "@get-keel/core"
publish packages/cli "@get-keel/cli"
publish packages/opencode-plugin "@get-keel/opencode-plugin"

node scripts/check-published.mjs

echo ""
echo "✅ All packages published!"
echo ""
echo "Test: npm install -g @get-keel/cli && keel --version"
echo "Plugin: add \"@get-keel/opencode-plugin\" to opencode.json, or run: keel install --opencode"
