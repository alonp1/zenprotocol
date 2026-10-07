#!/usr/bin/env bash
# Private ZP network on your machine: up | down | reset | status | logs | load | wallet   (docs/DEVNET.md)
#   scripts/devnet.sh up            build the image, start 3 nodes with a miner, wait for the first blocks
#   scripts/devnet.sh load 5,20,50  signed transactions at 5, 20, 50 per second (30 s each), prints a table
set -euo pipefail
cd "$(dirname "$0")/.."
C="docker compose -f docker-compose.devnet.yml"
API=${DEVNET_API:-http://127.0.0.1:20000}
tip() { curl -fs "$API/blockchain/info" 2>/dev/null | sed -n 's/.*"blocks": *\([0-9]*\).*/\1/p'; }
case "${1:-help}" in
  up)
    $C up -d --build
    echo "waiting for the nodes..."
    for _ in $(seq 120); do T=$(tip || true); [ -n "$T" ] && [ "$T" -ge 12 ] && break; sleep 3; done
    [ -n "${T:-}" ] && echo "devnet is running: block $T, API $API (nodes 2 and 3 on ports 20001, 20002)" || { $C logs --tail 40; echo "devnet did not start"; exit 1; }
    ;;
  down) $C down ;;
  reset) $C down -v ;;
  status) for p in 20000 20001 20002; do echo "port $p: $(curl -fs http://127.0.0.1:$p/blockchain/info 2>/dev/null | tr -d '\n ' | cut -c1-160 || echo 'not running')"; done ;;
  logs) $C logs -f --tail 50 ;;
  load)
    [ -d wallet/node_modules ] || (cd wallet && npm ci --no-audit --no-fund)
    node scripts/devnet/loadgen.mjs --rates "${2:-5,20,50}" --seconds "${3:-30}" --out devnet-result.json
    ;;
  wallet) echo "mining/test wallet (public devnet mnemonic): abandon x23 + art"; node -e "
    import('./wallet/src/keys.js').then(k=>{const a=k.accountFromMnemonic(Array(23).fill('abandon').concat('art').join(' '));console.log('address 0:',k.receiveAddress(a,0,'test'))})" ;;
  *) sed -n 2,4p "$0" ;;
esac
