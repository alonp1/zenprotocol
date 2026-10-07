#!/bin/bash
# Starts zen-node. MINER_THREADS>0 enables the CPU miner (needs a wallet - see Docker/README.md).
# EXTERNAL_IP lets other peers connect to this node.
# PUBLIC_NODE=1 public node for other users' wallets: no node wallet, address index, CORS (expose only via site/nginx-zen.conf).
# WALLET_API=1 serves the desktop Zen Wallet ("Mainnet | Local Node"): address index + CORS.
set -e
# Seeds: refresh the list from network.json in the repository (best effort, 10 s), so a moved seed server needs no new image.
# NETWORK_URL=off disables it.
NETWORK_URL="${NETWORK_URL:-https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/network.json}"
if [ "$NETWORK_URL" != "off" ]; then
  NEW=$(curl -fsSL -m 10 "$NETWORK_URL" 2>/dev/null | tr -d '\n' | sed -n 's/.*"seeds" *: *\[\([^]]*\)\].*/\1/p' | grep -o '"[^"]*"' | tr -d '"' || true)
  if [ -n "$NEW" ]; then
    for s in $NEW; do grep -q "^  - $s\$" /zen/main.yaml || sed -i "0,/^seeds:/s//seeds:\n  - $s/" /zen/main.yaml; done
    echo "seeds from network.json: $(echo $NEW)"
  fi
fi
ARGS=(--data-path /data --api "*:11567")
[ "${MINER_THREADS:-0}" -gt 0 ] && ARGS+=(--miner "$MINER_THREADS")
[ -n "${EXTERNAL_IP:-}" ] && ARGS+=(--ip "$EXTERNAL_IP")
if [ "${PUBLIC_NODE:-0}" = "1" ]; then ARGS+=(--remote --origin any)
elif [ "${WALLET_API:-0}" = "1" ]; then ARGS+=(--addressdb --origin any); fi
if [ -f /zen/zen-node.dll ]; then exec dotnet /zen/zen-node.dll "${ARGS[@]}" "$@"   # .NET 10 build
else exec mono /zen/zen-node.exe "${ARGS[@]}" "$@"; fi
