#!/bin/bash
# Mainnet replay test.
#
# Syncs two nodes from genesis side by side - the official 1.0.13 release and a node
# built from this repository - and checks that the source-built node validates every
# block exactly like the release: same block at sample heights, same tip, same CGP state.
#
# Needs Docker, ~60 GB disk, 4+ dedicated cores. Takes many hours.
#   bash scripts/replay-test.sh            # full replay
#   MAX_HOURS=2 bash scripts/replay-test.sh   # short run (partial, for testing the harness)
set -uo pipefail

cd "$(dirname "$0")/.."
MAX_HOURS="${MAX_HOURS:-36}"
STALL_MIN="${STALL_MIN:-60}"
POLL=300
OUT="${OUT:-replay-report}"
mkdir -p "$OUT"
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$OUT/replay.log"; }

log "== Building images"
docker build -q -f Docker/Dockerfile -t zen-node:release . >/dev/null || { log "release image build failed"; exit 2; }
docker build -q -f Docker/Dockerfile.source -t zen-node:source . >/dev/null || { log "source image build failed"; exit 2; }

for n in release source; do docker rm -f "replay-$n" >/dev/null 2>&1; docker volume rm -f "replay-$n" >/dev/null 2>&1; done
docker run -d --name replay-release -v replay-release:/data -p 127.0.0.1:11601:11567 zen-node:release >/dev/null
docker run -d --name replay-source  -v replay-source:/data  -p 127.0.0.1:11602:11567 zen-node:source  >/dev/null
trap 'docker logs --tail 200 replay-source > "$OUT/source-node.log" 2>&1; docker logs --tail 200 replay-release > "$OUT/release-node.log" 2>&1' EXIT

info() { curl -fs "http://127.0.0.1:$1/blockchain/info" 2>/dev/null; }
field() { echo "$1" | grep -o "\"$2\":[^,}]*" | head -1 | cut -d: -f2 | tr -d '"'; }

START=$(date +%s); last_src=0; last_src_t=$START
log "== Syncing both nodes from genesis (max ${MAX_HOURS}h)"
while true; do
  sleep $POLL
  R=$(info 11601); S=$(info 11602)
  rb=$(field "$R" blocks); sb=$(field "$S" blocks); hd=$(field "$R" headers)
  ribd=$(field "$R" initialBlockDownload); sibd=$(field "$S" initialBlockDownload)
  log "release=${rb:-?} source=${sb:-?} headers=${hd:-?}"
  now=$(date +%s)
  if [ -n "$sb" ] && [ "$sb" != "$last_src" ]; then last_src=$sb; last_src_t=$now; fi
  if [ $(( (now - last_src_t) / 60 )) -ge "$STALL_MIN" ] && [ "${rb:-0}" -gt "${sb:-0}" ]; then
    log "FAIL: source node stalled at block $sb for ${STALL_MIN} min while release is at $rb"; exit 1
  fi
  if [ "$ribd" = "false" ] && [ "$sibd" = "false" ] && [ "$rb" = "$sb" ]; then
    log "== Both nodes in sync at block $rb"; break
  fi
  if [ $(( (now - START) / 3600 )) -ge "$MAX_HOURS" ]; then
    log "Time limit reached (partial run): release=$rb source=$sb"; PARTIAL=1; break
  fi
done

TOP=$(( ${rb:-0} < ${sb:-0} ? ${rb:-0} : ${sb:-0} ))
log "== Comparing blocks up to $TOP"
FAIL=0
for h in $(seq 1 50000 "$TOP") $((TOP - 100)) "$TOP"; do
  [ "$h" -lt 1 ] && continue
  a=$(curl -fs "http://127.0.0.1:11601/blockchain/block?blockNumber=$h" | sha256sum | cut -c1-16)
  b=$(curl -fs "http://127.0.0.1:11602/blockchain/block?blockNumber=$h" | sha256sum | cut -c1-16)
  if [ "$a" = "$b" ]; then log "block $h  match"; else log "block $h  MISMATCH ($a vs $b)"; FAIL=1; fi
done

if [ -z "${PARTIAL:-}" ]; then
  for ep in cgp totalzp winner; do
    a=$(curl -fs "http://127.0.0.1:11601/blockchain/$ep"); b=$(curl -fs "http://127.0.0.1:11602/blockchain/$ep")
    if [ "$a" = "$b" ]; then log "$ep  match"; else log "$ep  MISMATCH"; echo "$a" > "$OUT/$ep.release.json"; echo "$b" > "$OUT/$ep.source.json"; FAIL=1; fi
  done
fi

if [ "$FAIL" = 0 ]; then log "RESULT: PASS${PARTIAL:+ (partial, up to block $TOP)}"; else log "RESULT: FAIL"; fi
docker rm -f replay-release replay-source >/dev/null 2>&1
exit $FAIL
