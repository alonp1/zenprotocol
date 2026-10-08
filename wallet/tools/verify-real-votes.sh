#!/usr/bin/env bash
# Read-only: checks the wallet's vote code against real mainnet votes. Run on the MAINNET server, in the repo.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
docker run --rm --network host -v "$REPO:/r:ro" -v /var/lib/zen-stats:/var/lib/zen-stats:ro -w /r/wallet node:22-alpine \
  node --no-warnings --experimental-sqlite tools/verify-real-votes.mjs "$@"
