#!/bin/bash
# Starts zen-node. MINER_THREADS>0 enables the CPU miner (needs a wallet - see Docker/README.md).
# EXTERNAL_IP lets other peers connect to this node.
# PUBLIC_NODE=1 public node for other users' wallets: no node wallet, address index, CORS (expose only via site/nginx-zen.conf).
# WALLET_API=1 serves the desktop Zen Wallet ("Mainnet | Local Node"): address index + CORS.
# NETWORK=test runs the revived testnet (docs/TESTNET.md): P2P 29555, API 31567. SEEDS="host,ip:port" replaces its seeds (a host name without port uses the node port).
# TESTNET_MNEMONIC="24 words" gives the node's wallet (the miner's address) a known phrase, so a test can spend the rewards.
set -e
NET="${NETWORK:-main}"; YAML=/zen/main.yaml; API_PORT=11567; SEEDKEY=seeds
if [ "$NET" = test ]; then YAML=/zen/test.yaml; API_PORT=31567; SEEDKEY=testnetSeeds; fi
if [ -n "${SEEDS:-}" ]; then
  NETWORK_URL=off
  { echo "seeds:"; echo "$SEEDS" | tr ',' '\n' | sed 's/^/  - /'; } > /tmp/seeds.yaml
  awk 'BEGIN{skip=0} /^seeds:/{while((getline line < "/tmp/seeds.yaml")>0) print line; skip=1; next} skip&&/^  - /{next} {skip=0; print}' "$YAML" > /tmp/new.yaml && cp /tmp/new.yaml "$YAML"
fi
# Seeds: refresh the list from network.json in the repository (best effort, 10 s), so a moved seed server needs no new image.
# NETWORK_URL=off disables it.
NETWORK_URL="${NETWORK_URL:-https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/network.json}"
if [ "$NETWORK_URL" != "off" ]; then
  NEW=$(curl -fsSL -m 10 "$NETWORK_URL" 2>/dev/null | tr -d '\n' | sed -n "s/.*\"$SEEDKEY\" *: *\[\([^]]*\)\].*/\1/p" | grep -o '"[^"]*"' | tr -d '"' || true)
  if [ -n "$NEW" ]; then
    for s in $NEW; do grep -q "^  - $s\$" "$YAML" || sed -i "0,/^seeds:/s//seeds:\n  - $s/" "$YAML"; done
    echo "seeds from network.json: $(echo $NEW)"
  fi
fi
run_node() { if [ -f /zen/zen-node.dll ]; then dotnet /zen/zen-node.dll "$@"; else mono /zen/zen-node.exe "$@"; fi; }
ARGS=(--data-path /data --api "*:$API_PORT")
[ "$NET" = test ] && ARGS+=(--test)
[ "${MINER_THREADS:-0}" -gt 0 ] && ARGS+=(--miner "$MINER_THREADS")
[ -n "${EXTERNAL_IP:-}" ] && ARGS+=(--ip "$EXTERNAL_IP")
if [ "${PUBLIC_NODE:-0}" = "1" ]; then ARGS+=(--remote --origin any)
elif [ "${WALLET_API:-0}" = "1" ]; then ARGS+=(--addressdb --origin any); fi
# A known wallet phrase for the miner (test networks only): import it once, before the first real start.
if [ -n "${TESTNET_MNEMONIC:-}" ] && [ "$NET" = test ] && [ ! -f /data/wallet-imported ]; then
  run_node "${ARGS[@]}" > /tmp/setup.log 2>&1 & P=$!
  for _ in $(seq 120); do curl -fs "http://127.0.0.1:$API_PORT/blockchain/info" >/dev/null && break; sleep 1; done
  JSON=$(printf '{"password":"%s","words":[%s]}' "${TESTNET_PASSWORD:-testnet}" "$(echo "$TESTNET_MNEMONIC" | sed 's/[^ ][^ ]*/"&"/g; s/ /,/g')")
  OUT=$(curl -s -X POST -H "Content-Type: application/json" -d "$JSON" "http://127.0.0.1:$API_PORT/wallet/import")
  echo "wallet import: $OUT"
  case "$OUT" in *imported*) touch /data/wallet-imported ;; *) tail -n 20 /tmp/setup.log; exit 1 ;; esac
  kill $P; wait $P 2>/dev/null || true
fi
if [ -f /zen/zen-node.dll ]; then exec dotnet /zen/zen-node.dll "${ARGS[@]}" "$@"   # .NET 10 build
else exec mono /zen/zen-node.exe "${ARGS[@]}" "$@"; fi
