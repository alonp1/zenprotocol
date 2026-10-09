#!/usr/bin/env bash
# Read-only CGP voting readiness check (tools/cgp-check.mjs) in a throwaway node container. No keys, nothing is published.
# usage (on the server of the node, from the repo):  bash wallet/tools/cgp-check.sh [--net main|test] [--node URL]
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
docker run --rm --network host -v "$REPO:/r" -w /r/wallet node:22-alpine sh -c \
  '[ -d node_modules/@noble ] || npm ci --no-audit --no-fund --silent; node --no-warnings tools/cgp-check.mjs "$@"' sh "$@"
