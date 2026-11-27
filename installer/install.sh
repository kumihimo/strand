#!/bin/sh
# Checks for Node 24+, then hands over to the cross-platform installer.
set -e
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 or newer is required. Install it from https://nodejs.org and re-run." >&2
  exit 1
fi
major=$(node -p "process.versions.node.split('.')[0]")
if [ "$major" -lt 24 ]; then
  echo "Node.js $major found; 24 or newer is required. Install it from https://nodejs.org and re-run." >&2
  exit 1
fi
exec node "$(dirname "$0")/setup.ts" "$@"
