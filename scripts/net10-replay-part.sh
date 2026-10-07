#!/bin/bash
# One part of the .NET 10 mainnet replay on a GitHub-hosted runner (max 6 h per job).
# Syncs the net10 image from genesis (or from the data saved by the previous part) until the
# reference height, or until the time budget is used. Writes "done=true|false" to $GITHUB_OUTPUT.
#
#   BUDGET_MIN=315 bash scripts/net10-replay-part.sh
set -uo pipefail
cd "$(dirname "$0")/.."
BUDGET_MIN="${BUDGET_MIN:-315}"
DATA="$PWD/replay-data"
mkdir -p "$DATA"

git fetch -q origin reference-data
REF=$(git ls-tree -d --name-only origin/reference-data replay/reference/ | sort | tail -1)
H=$(git show "origin/reference-data:$REF/README.txt" | grep '^height:' | awk '{print $2}')
echo "reference $REF, height $H"

docker run -d --name zn -v "$DATA:/data" -p 127.0.0.1:11567:11567 zen-node:net10 >/dev/null
start=$(date +%s); last=0; tip=0
while :; do
  sleep 60
  tip=$(curl -fs http://127.0.0.1:11567/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)["blocks"])' 2>/dev/null || echo "$tip")
  el=$(( ($(date +%s) - start) / 60 ))
  if (( el % 15 == 0 )); then echo "$(date -u +%H:%M) +${el}m tip $tip ($(( (tip - last) / 15 ))/min) disk $(df -h --output=avail / | tail -1)"; last=$tip; fi
  if ! docker ps -q -f name=zn | grep -q .; then echo "node stopped:"; docker logs --tail 40 zn; exit 1; fi
  [ "$tip" -ge "$H" ] && break
  [ "$el" -ge "$BUDGET_MIN" ] && break
done
echo "::notice title=replay part::tip $tip of $H after $(( ($(date +%s) - start) / 60 )) min"
docker logs zn 2>&1 | grep -E "ERR|Exception|invalid|Invalid" | grep -v "Peer\|peer" | tail -20 | sed 's/^/log: /'

if [ "$tip" -ge "$H" ]; then
  API=127.0.0.1:11567 bash scripts/check-against-reference.sh; rc=$?
  # state check against the community node (old Mono release) when both are at the same tip
  for i in $(seq 1 30); do
    a=$(curl -fs http://127.0.0.1:11567/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)["blocks"])')
    b=$(curl -fs https://zen.sealinkgps.com/node/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)["blocks"])')
    if [ "$a" = "$b" ]; then
      for ep in cgp totalzp winner; do
        x=$(curl -fs http://127.0.0.1:11567/blockchain/$ep); y=$(curl -fs https://zen.sealinkgps.com/node/blockchain/$ep)
        [ "$x" = "$y" ] && echo "$ep matches the release node at $a" || { echo "$ep MISMATCH at $a: $x vs $y"; rc=1; }
      done
      break
    fi
    sleep 60
  done
  docker stop zn >/dev/null
  echo "done=true" >> "$GITHUB_OUTPUT"
  exit $rc
fi
docker stop -t 60 zn >/dev/null
echo "done=false" >> "$GITHUB_OUTPUT"
