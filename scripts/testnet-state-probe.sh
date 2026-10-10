#!/usr/bin/env bash
# Does a contract see the state it saved? Activates StateProbe.fst, then set -> get, setdict -> get.
# usage: scripts/testnet-state-probe.sh [api-url] [password]
set -uo pipefail
API=${1:-http://127.0.0.1:20000}; PW=${2:-devnet}
post() { curl -s -X POST -H "Content-Type: application/json" -d "$2" "$API$1"; }
tip() { curl -fs "$API/blockchain/info" | sed -n 's/.*"blocks": *\([0-9]*\).*/\1/p'; }
wait2() { local T; T=$(tip); for k in $(seq 120); do sleep 1; [ "$(tip)" -gt $((T+1)) ] && break; done; }
CONTRACT=src/ContractExamples/StateProbe.fst EXECUTE=0 NUMBLOCKS=300 ERRCHARS=6000 bash scripts/testnet-contract.sh "$API" "$PW" | tee /tmp/probe-activate.txt
ADDR=$(sed -n 's/^CONTRACT_ADDRESS=//p' /tmp/probe-activate.txt | head -1)
[ -n "$ADDR" ] || { echo "PROBE activation failed"; exit 1; }
ex() { B=$(ADDR="$ADDR" C="$1" PW="$PW" python3 -c "import json,os;print(json.dumps({'address':os.environ['ADDR'],'command':os.environ['C'],'messageBody':'','options':{'returnAddress':False},'spends':[],'password':os.environ['PW']}))"); post /wallet/contract/execute "$B" | cut -c1-200; }
echo "PROBE get before anything: $(ex get)"
echo "PROBE set: $(ex set)"; wait2
echo "PROBE get after set: $(ex get)"
echo "PROBE setdict: $(ex setdict)"; wait2
echo "PROBE get after setdict: $(ex get)"
