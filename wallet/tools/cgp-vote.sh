#!/usr/bin/env bash
# Runs tools/cgp-vote.mjs in a throwaway node container (nothing to install on the server), with the node's own
# testnet wallet. Extra arguments go to the tool: --once, --send, --net, --node.
# usage (testnet server, from the repo):  bash wallet/tools/cgp-vote.sh [--once] [--send]
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
MN=$(grep '^TESTNET_MNEMONIC=' "$REPO/.env" | cut -d= -f2- | tr -d '"')
[ -n "$MN" ] || { echo "no TESTNET_MNEMONIC in $REPO/.env"; exit 1; }
docker run --rm --network host -e TESTNET_MNEMONIC="$MN" -v "$REPO:/r" -w /r/wallet node:22-alpine sh -c \
  '[ -d node_modules/@noble ] || npm ci --no-audit --no-fund --silent; node --no-warnings tools/cgp-vote.mjs "$@"' sh "$@"
