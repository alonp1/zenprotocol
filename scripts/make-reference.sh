#!/bin/bash
# Build a reference file from the OFFICIAL 1.0.13 node, for future replay tests.
#
# Uses the fully synced data left by replay-test.sh (Docker volume `replay-release`),
# or any synced release node API given with API=host:port.
# Output: replay/reference/mainnet-<height>/
#   blocks.txt       "<height> <block hash>" every STEP blocks + the tip
#   cgp-history.json, totalzp.json, winner.json, cgp.json   chain state at the tip
#   SHA256SUMS
# The tip hash alone pins the whole chain (each header commits to its parent);
# the sampled hashes locate a divergence quickly.
set -euo pipefail
cd "$(dirname "$0")/.."

STEP="${STEP:-1000}"
VOLUME="${VOLUME:-replay-release}"
STARTED=""

if [ -z "${API:-}" ]; then
  API=127.0.0.1:11603
  docker rm -f ref-release >/dev/null 2>&1 || true
  docker run -d --name ref-release -v "$VOLUME":/data -p "$API":11567 zen-node:release >/dev/null
  STARTED=1
  trap 'docker rm -f ref-release >/dev/null 2>&1 || true' EXIT
  for i in $(seq 1 60); do curl -fs "http://$API/blockchain/info" >/dev/null && break; sleep 5; done
fi

height() { curl -fs "http://$API/blockchain/info" | grep -o '"blocks":[0-9]*' | cut -d: -f2; }

# chain state and height must belong together: retry if a new block arrives meanwhile
STATE=$(mktemp -d)
for attempt in $(seq 1 10); do
  H=$(height)
  for ep in cgp cgp/history totalzp winner; do
    curl -fs "http://$API/blockchain/$ep" > "$STATE/$(echo "$ep" | tr / -).json" || echo "null" > "$STATE/$(echo "$ep" | tr / -).json"
  done
  [ "$(height)" = "$H" ] && break
  echo "new block arrived, retrying state snapshot"
done
echo "release node at block $H"
OUT="replay/reference/mainnet-$H"
mkdir -p "$OUT"
cp "$STATE"/*.json "$OUT"/

: > "$OUT/blocks.txt"
for h in $(seq "$STEP" "$STEP" "$H") "$H"; do
  hash=$(curl -fs "http://$API/blockchain/block?blockNumber=$h" | grep -o '"hash":"[0-9a-f]*"' | head -1 | cut -d'"' -f4)
  [ -n "$hash" ] || { echo "no hash for block $h"; exit 1; }
  echo "$h $hash" >> "$OUT/blocks.txt"
done
sort -n -u "$OUT/blocks.txt" -o "$OUT/blocks.txt"

printf 'source: zen-node 1.0.13 (official npm release)\nheight: %s\ncreated: %s\nstep: %s\n' \
  "$H" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STEP" > "$OUT/README.txt"
(cd "$OUT" && sha256sum *.txt *.json | grep -v SHA256SUMS > SHA256SUMS)

echo "reference written to $OUT ($(wc -l < "$OUT/blocks.txt") block hashes)"
