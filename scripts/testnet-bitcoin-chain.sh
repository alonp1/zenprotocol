#!/usr/bin/env bash
# BitZen step T3: activate BitcoinHeaderChain.fst (Bitcoin headers kept in contract state), then add N headers
# one by one (each must point to the tip in the state), then try a header that does not link. Records timing.
# The headers are made here at regtest difficulty (nbits 207fffff): the contract checks the proof of work each
# header claims, so the cost and state size are the same as with real headers.
# usage: scripts/testnet-bitcoin-chain.sh [api-url] [password]     N=headers (default 120)
set -uo pipefail
API=${1:-http://127.0.0.1:31567}; PW=${2:-testnet}; N=${N:-30}
ZO="dotnet src/Oracle/bin/Release/zen-oracle.dll"
post() { curl -s -X POST -H "Content-Type: application/json" -d "$2" "$API$1"; }
tip() { curl -fs "$API/blockchain/info" | sed -n 's/.*"blocks": *\([0-9]*\).*/\1/p'; }

echo "== activate BitcoinHeaderChain.fst (F* verifies it: this takes minutes)"
CONTRACT=src/ContractExamples/BitcoinHeaderChain.fst EXECUTE=0 NUMBLOCKS=${NUMBLOCKS:-300} ERRCHARS=6000 bash scripts/testnet-contract.sh "$API" "$PW" | tee /tmp/btc-chain-activate.txt
ADDR=$(sed -n 's/^CONTRACT_ADDRESS=//p' /tmp/btc-chain-activate.txt | head -1)
[ -n "$ADDR" ] || { echo "activation failed"; exit 1; }

python3 - "$N" > /tmp/headers.txt <<'PY'
import hashlib, struct, sys
n = int(sys.argv[1]) + 1
bits = 0x207fffff
target = (bits & 0xffffff) * 2 ** (8 * ((bits >> 24) - 3))
def dsha(b): return hashlib.sha256(hashlib.sha256(b).digest()).digest()
prev = b"\x00" * 32
for i in range(n):
    root = dsha(b"bitzen%d" % i)
    nonce = 0
    while True:
        h = struct.pack("<I", 1) + prev + root + struct.pack("<III", 1700000000 + i * 600, bits, nonce)
        d = dsha(h)
        if int.from_bytes(d, "little") <= target: break
        nonce += 1
    print(h.hex())
    prev = d
PY
echo "made $(wc -l < /tmp/headers.txt) headers"
# an old header (number 2) is tried at the end: it does not follow the tip, so it must be rejected
BAD=$(sed -n 2p /tmp/headers.txt); head -n -1 /tmp/headers.txt > /tmp/good.txt

add() {  # header -> 0 if accepted
  local BODY B R
  BODY=$($ZO body header:s=$1)
  B=$(ADDR="$ADDR" BODY="$BODY" PW="$PW" python3 -c "import json,os;print(json.dumps({'address':os.environ['ADDR'],'command':'add','messageBody':os.environ['BODY'],'options':{'returnAddress':True},'spends':[],'password':os.environ['PW']}))")
  R=$(post /wallet/contract/execute "$B")
  echo "$R" | grep -Eq '^"[0-9a-f]{64}"$' && return 0
  echo "  rejected: $(echo "$R" | cut -c1-300)"; return 1
}
RC=0; I=0; T0=$(date +%s)
while read -r H; do
  I=$((I+1)); S=$(date +%s)
  ok=0
  for try in 1 2 3; do   # a refusal can mean the previous header is not in a block yet: wait one more block and try again
    if add "$H"; then ok=1; break; fi
    T=$(tip); for k in $(seq 180); do sleep 1; [ "$(tip)" -gt "$T" ] && break; done
  done
  [ $ok = 1 ] || { echo "FAIL header $I"; RC=1; break; }
  T=$(tip); for k in $(seq 180); do sleep 1; [ "$(tip)" -gt "$T" ] && break; done
  if [ $I -le 3 ] || [ $((I % 10)) -eq 0 ]; then echo "  header $I accepted, $(( $(date +%s) - S )) s"; fi
  [ $((I % 10)) -eq 0 ] && echo "added $I headers so far, $(( $(date +%s) - T0 )) s"
done < /tmp/good.txt
echo "added $I headers in $(( $(date +%s) - T0 )) s"
# the skipped header (two ahead of the tip) must be rejected
if add "$BAD"; then echo "FAIL: a header that does not follow the tip was accepted"; RC=1; else echo "PASS: header that does not follow the tip rejected"; fi
echo "RESULT=$RC"; exit $RC
