#!/bin/bash
# Check a synced node against the stored mainnet reference (branch `reference-data`).
#
#   API=127.0.0.1:11567 bash scripts/check-against-reference.sh [replay/reference/mainnet-1052892]
#
# Fetches the reference from GitHub if the folder is not present. Compares every block hash in
# blocks.txt (every 1000 blocks + the tip) and the CGP/supply state. Exit 0 = identical.
set -euo pipefail
cd "$(dirname "$0")/.."
API="${API:-127.0.0.1:11567}"
REF="${1:-}"

if [ -z "$REF" ]; then
  git fetch -q origin reference-data
  REF=$(git ls-tree -d --name-only origin/reference-data replay/reference/ | sort | tail -1)
  rm -rf "$REF" && mkdir -p "$REF"
  for f in $(git ls-tree --name-only origin/reference-data "$REF/"); do git show "origin/reference-data:$f" > "$f"; done
fi
(cd "$REF" && sha256sum -c --quiet SHA256SUMS) || { echo "reference files corrupted"; exit 2; }

H=$(grep '^height:' "$REF/README.txt" | awk '{print $2}')
tip=$(curl -fs "http://$API/blockchain/info" | python3 -c 'import json,sys; print(json.load(sys.stdin)["blocks"])')
[ "$tip" -ge "$H" ] || { echo "node at $tip, below reference height $H - sync first"; exit 2; }

fail=0; n=0
while read -r h hash; do
  got=$(curl -fs "http://$API/blockchain/block?blockNumber=$h" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hash"])' || true)
  n=$((n+1))
  if [ "$got" != "$hash" ]; then echo "MISMATCH block $h: node $got, reference $hash"; fail=1; break; fi
done < "$REF/blocks.txt"
echo "block hashes: $n checked"

# state files describe the chain AT the reference height; only comparable when the node is exactly there
if [ "$tip" = "$H" ]; then
  for ep in cgp totalzp winner; do
    got=$(curl -fs "http://$API/blockchain/$ep" || echo null)
    if [ "$got" = "$(cat "$REF/$ep.json")" ]; then echo "$ep match"; else echo "$ep MISMATCH"; fail=1; fi
  done
else
  echo "state files skipped (node at $tip, reference at $H): block hashes are the check"
fi
[ "$fail" = 0 ] && echo "RESULT: node matches the reference" || echo "RESULT: MISMATCH"
exit $fail
