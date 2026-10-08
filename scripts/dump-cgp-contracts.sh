#!/usr/bin/env bash
# Read-only: saves the source code of the mainnet CGP and voting contracts from a running mainnet node,
# so the same contracts (same code, same ids) can be activated on the testnet. Changes nothing.
# usage: scripts/dump-cgp-contracts.sh [api-url] [out-dir]
set -euo pipefail
API=${1:-http://127.0.0.1:31567}; OUT=${2:-cgp-contracts}
CGP=00000000cdaa2a511cd2e1d07555b00314d1be40a649d3b6f419eb1e4e7a8e63240a36d1
VOTING=000000006ea5457ed23e3e13f31fe4cfd46c200587f2e4cc22df30ac77790f6d2c15cc12
mkdir -p "$OUT"
curl -fsS "$API/contract/active" > "$OUT/active.json"
python3 - "$OUT" "$CGP" "$VOTING" <<'PY'
import json, sys
out, cgp, voting = sys.argv[1:4]
active = json.load(open(f"{out}/active.json"))
for name, cid in (("CGP", cgp), ("Voting", voting)):
    c = next((x for x in active if x.get("contractId") == cid), None)
    if not c:
        print(f"{name}: NOT in the active list ({len(active)} active contracts)"); continue
    open(f"{out}/{name}.fst", "w").write(c["code"])
    print(f"{name}: {len(c['code'])} characters, expires at block {c.get('expire')}, saved to {out}/{name}.fst; fields: {sorted(c)}")
PY
echo "sha256 of each file:"; sha256sum "$OUT"/CGP.fst "$OUT"/Voting.fst 2>/dev/null || true
