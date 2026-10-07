#!/bin/bash
# ZP devnet: NODES nodes of the built-in `local` chain in one container (Debug build, see docs/DEVNET.md).
#   node i: P2P 127.0.0.1:10000+i (inside the container), API *:20000+i, address index on.
#   node 0 mines (MINER_THREADS, 0 = off) to a wallet imported from DEVNET_MNEMONIC.
# The default mnemonic is PUBLIC and worthless: anyone can spend the devnet coins. That is intended.
set -u
NODES="${NODES:-3}"
MINER_THREADS="${MINER_THREADS:-1}"
PASS="${DEVNET_PASSWORD:-devnet}"
WORDS="${DEVNET_MNEMONIC:-abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art}"
cd /zen
mkdir -p /data/logs

args() { echo --local "$1" --data-path "/data/node$1" --api "*:$((20000 + $1))" --addressdb; }
wait_api() { for _ in $(seq 180); do curl -fs "http://127.0.0.1:$1/blockchain/info" >/dev/null && return 0; sleep 1; done; return 1; }

# Phase 1 (first start only): give node 0 its wallet, so that the miner has an address to pay.
if [ ! -f /data/node0/wallet-imported ]; then
  mkdir -p /data/node0
  dotnet zen-node.dll $(args 0) > /data/logs/node0-setup.log 2>&1 &
  P=$!
  if ! wait_api 20000; then echo "devnet: node 0 did not start"; tail -n 40 /data/logs/node0-setup.log; exit 1; fi
  JSON=$(printf '{"password":"%s","words":[%s]}' "$PASS" "$(echo "$WORDS" | sed 's/[^ ][^ ]*/"&"/g; s/ /,/g')")
  OUT=$(curl -s -X POST -H "Content-Type: application/json" -d "$JSON" http://127.0.0.1:20000/wallet/import)
  echo "devnet: wallet import: $OUT"
  case "$OUT" in *imported*) touch /data/node0/wallet-imported ;; *) tail -n 20 /data/logs/node0-setup.log; exit 1 ;; esac
  kill $P; wait $P 2>/dev/null
fi

PIDS=()
for i in $(seq 0 $((NODES - 1))); do
  EXTRA=()
  [ "$i" = 0 ] && [ "$MINER_THREADS" -gt 0 ] && EXTRA=(--miner "$MINER_THREADS")
  if [ "$i" = 0 ]; then dotnet zen-node.dll $(args $i) "${EXTRA[@]}" 2>&1 | tee /data/logs/node0.log &
  else dotnet zen-node.dll $(args $i) "${EXTRA[@]}" > "/data/logs/node$i.log" 2>&1 &
  fi
  PIDS+=($!)
  [ "$i" = 0 ] && wait_api 20000   # the others find node 0 on 127.0.0.1:10000
done
echo "devnet: $NODES nodes up, APIs on ports 20000-$((20000 + NODES - 1)), miner threads $MINER_THREADS"
trap 'kill "${PIDS[@]}" 2>/dev/null' TERM INT
wait -n "${PIDS[@]}"
echo "devnet: a node stopped, shutting down"; kill "${PIDS[@]}" 2>/dev/null; exit 1
