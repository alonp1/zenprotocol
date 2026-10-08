#!/usr/bin/env bash
# Runs tools/cgp-sim.mjs in a throwaway node container (nothing to install on the server), with the node's own
# testnet wallet. Arguments go to the tool: plan | fund | run, --send, --net, --node.
# usage (testnet server, from the repo):  bash wallet/tools/cgp-sim.sh plan|fund|run [--send]
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
MN=$(grep '^TESTNET_MNEMONIC=' "$REPO/.env" | cut -d= -f2- | tr -d '"')
[ -n "$MN" ] || { echo "no TESTNET_MNEMONIC in $REPO/.env"; exit 1; }
docker run --rm --network host -e TESTNET_MNEMONIC="$MN" -v "$REPO:/r" -w /r/wallet node:22-alpine sh -c \
  '[ -d node_modules/@noble ] || npm ci --no-audit --no-fund --silent; node --no-warnings tools/cgp-sim.mjs "$@"' sh "$@"
