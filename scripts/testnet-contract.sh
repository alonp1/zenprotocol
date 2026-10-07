#!/usr/bin/env bash
# Contract experiment on a running testnet node whose wallet is the public test mnemonic:
# activate src/ContractExamples/Token.fst, wait for it to be active, buy tokens by executing it.
# usage: scripts/testnet-contract.sh [api-url] [password]
set -euo pipefail
API=${1:-http://127.0.0.1:31567}; PW=${2:-testnet}
CODE=${CONTRACT:-src/ContractExamples/Token.fst}
j() { python3 -c "import json,sys;print(json.dumps($1))"; }
post() { curl -s -X POST -H "Content-Type: application/json" -d "$2" "$API$1"; }

echo "== activate $CODE"
BODY=$(CODE="$CODE" PW="$PW" python3 -c "import json,os,re;print(json.dumps({'code':re.sub(r'^module \w+\s*\n','',open(os.environ['CODE']).read()),'numberOfBlocks':100,'password':os.environ['PW'],**({'rlimit':int(os.environ['RLIMIT'])} if os.environ.get('RLIMIT') else {})}))")
OUT=$(post /wallet/contract/activate "$BODY"); echo "$OUT" | cut -c1-300
echo "$OUT" | grep -q contractId || { echo "activation failed"; exit 1; }
ADDR=$(echo "$OUT" | python3 -c "import json,sys;print(json.load(sys.stdin)['address'])")
CID=$(echo "$OUT" | python3 -c "import json,sys;print(json.load(sys.stdin)['contractId'])")

echo "== wait until the contract is active"
for i in $(seq 120); do
  curl -fs "$API/contract/active" | grep -q "$CID" && break; sleep 10
done
curl -fs "$API/contract/active" | grep -q "$CID" || { echo "contract never became active"; exit 1; }
echo "active after $((i*10)) s: $ADDR"
echo "CONTRACT_ADDRESS=$ADDR"
[ "${EXECUTE:-1}" = 0 ] && exit 0

echo "== execute: buy tokens with 1000 kalapas"
BODY=$(ADDR="$ADDR" PW="$PW" python3 -c "import json,os;print(json.dumps({'address':os.environ['ADDR'],'command':'buy','messageBody':'','options':{'returnAddress':True},'spends':[{'asset':'00','amount':1000}],'password':os.environ['PW']}))")
OUT=$(post /wallet/contract/execute "$BODY"); echo "$OUT" | cut -c1-300
echo "$OUT" | grep -qi "error\|fail" && { echo "execute failed"; exit 1; } || true

echo "== wait for the minted token in the wallet"
for i in $(seq 60); do
  B=$(curl -fs "$API/wallet/balance" || true)
  echo "$B" | grep -qi "${CID:0:8}" && { echo "token balance: $B" | cut -c1-300; exit 0; }
  sleep 10
done
echo "no token in the wallet"; echo "$B" | cut -c1-300; exit 1
