#!/bin/bash
# Build the address index (AddressDB) once on a machine with plenty of RAM and export a
# snapshot that contains it, so public/wallet nodes do not have to index the chain themselves.
#
# Why: release 1.0.13 builds the index by loading the whole chain into memory in one message,
# which crashes on a 1M+ block chain. The source build indexes in batches of 5000 blocks.
# The index format is unchanged, so release nodes load and update it normally.
#
# Uses the synced data of Docker volume VOLUME (default: replay-release, left by replay-test.sh).
# Output: $OUT/zen-node-<date>-<height>.zip + .sha256  (chain + contracts + addressdb, no wallet)
#   bash scripts/make-addressdb-snapshot.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VOLUME="${VOLUME:-replay-release}"
IMAGE="${IMAGE:-zen-node:addressdb}"
OUT="${OUT:-$HOME/zen-out}"
MAX_HOURS="${MAX_HOURS:-8}"
mkdir -p "$OUT"

docker build -q -f Docker/Dockerfile.source -t "$IMAGE" . >/dev/null
docker rm -f addr-build >/dev/null 2>&1 || true
trap 'docker rm -f addr-build >/dev/null 2>&1 || true' EXIT

echo "== Building AddressDB on volume $VOLUME (max ${MAX_HOURS}h)"
docker run -d --name addr-build -v "$VOLUME":/data -p 127.0.0.1:11604:11567 "$IMAGE" --addressdb >/dev/null
START=$(date +%s)
until docker logs addr-build 2>&1 | grep -q "AddressDB synced to block"; do
  docker inspect -f '{{.State.Running}}' addr-build | grep -q true || { echo "node stopped:"; docker logs --tail 50 addr-build; exit 1; }
  [ $(( ($(date +%s) - START) / 3600 )) -lt "$MAX_HOURS" ] || { echo "timeout"; exit 1; }
  echo "[$(date -u +%H:%M)] $(docker logs addr-build 2>&1 | grep -o 'catch-up at block.*' | tail -1) mem $(docker stats --no-stream --format '{{.MemUsage}}' addr-build)"
  sleep 120
done
H=$(docker logs addr-build 2>&1 | grep -o "AddressDB synced to block #[0-9]*" | tail -1 | grep -o "[0-9]*$")
echo "== AddressDB synced at block $H"
docker stop -t 60 addr-build >/dev/null

echo "== Creating snapshot"
docker run --rm -v "$VOLUME":/data --entrypoint /create-snapshot.sh "$IMAGE" "$H"
docker run --rm -v "$VOLUME":/data -v "$OUT":/out --entrypoint sh "$IMAGE" -c \
  "cp /data/snapshots/zen-node-*-$H.zip /data/snapshots/zen-node-*-$H.zip.sha256 /out/ && rm -f /data/snapshots/zen-node-*-$H.zip*"
ls -lh "$OUT"
echo "== Done. To hand it to the community server, on this machine run:"
echo "   cd $OUT && python3 -m http.server 8000"
echo "and on the community server: see docs/SETUP.md 'Public node for wallets'."
