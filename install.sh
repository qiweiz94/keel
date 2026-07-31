#!/bin/bash
set -e

echo "keel — Installing..."

# Detect OS
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)  OS="macos" ;;
  Linux)   OS="linux" ;;
  *)       echo "Unsupported OS: $OS"; exit 1 ;;
esac

echo "  Detected: $OS ($ARCH)"

# Check for Node.js
if ! command -v node &>/dev/null; then
  echo "  Node.js is required. Install it from https://nodejs.org"
  echo "  Or use: brew install node"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "  Node.js 18+ is required. Current: $(node -v)"
  exit 1
fi

echo "  Node.js $(node -v) ✓"

# Install via npm
# Do not pipe into tail without checking status: the pipeline's exit code is
# tail's, so a failed install still printed "installed successfully!".
if ! npm install -g keel; then
  echo ""
  echo "  Install failed. keel is NOT installed."
  echo "  If this is a permissions error, try: sudo npm install -g keel"
  exit 1
fi

echo ""
echo "  keel installed successfully!"
echo ""
echo "  Quick start:"
echo "    cd your-project"
echo "    keel init --hooks"
echo "    keel check --ci"
echo ""
