#!/usr/bin/env bash
# BitZen step T1 on a testnet node (see github.com/alonp1/bitzen): activate src/ContractExamples/BitcoinHeader.fst and check
# that it accepts two real consecutive Bitcoin headers (genesis and block 1) and rejects wrong pairs.
# usage: scripts/testnet-bitcoin.sh [api-url] [password]     (needs dotnet 10 and the built oracle project for `body`)
set -uo pipefail
API=${1:-http://127.0.0.1:31567}; PW=${2:-testnet}
ZO="dotnet src/Oracle/bin/Release/zen-oracle.dll"
GEN=0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c
B1=010000006fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000982051fd1e4ba744bbbe680e1fee14677ba1a3c3540bf7b1cdb606e857233e0e61bc6649ffff001d01e36299
B1BAD=010000006fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000982051fd1e4ba744bbbe680e1fee14677ba1a3c3540bf7b1cdb606e857233e0e61bc6649ffff001d01e36298
post() { curl -s -X POST -H "Content-Type: application/json" -d "$2" "$API$1"; }

echo "== activate BitcoinHeader.fst (F* verifies it: this takes minutes)"
CONTRACT=src/ContractExamples/BitcoinHeader.fst EXECUTE=0 NUMBLOCKS=${NUMBLOCKS:-300} bash scripts/testnet-contract.sh "$API" "$PW" | tee /tmp/btc-activate.txt
ADDR=$(sed -n 's/^CONTRACT_ADDRESS=//p' /tmp/btc-activate.txt | head -1)
[ -n "$ADDR" ] || { echo "activation failed"; exit 1; }

run() {  # name h1 h2 expect(ok|fail)
  local BODY B R
  BODY=$($ZO body header1:s=$2 header2:s=$3)
  B=$(ADDR="$ADDR" BODY="$BODY" PW="$PW" python3 -c "import json,os;print(json.dumps({'address':os.environ['ADDR'],'command':'check','messageBody':os.environ['BODY'],'options':{'returnAddress':True},'spends':[],'password':os.environ['PW']}))")
  R=$(post /wallet/contract/execute "$B")
  echo "  $1 -> $(echo "$R" | cut -c1-200)"
  if echo "$R" | grep -Eq '^"[0-9a-f]{64}"$'; then [ "$4" = ok ] && echo "  PASS $1" || { echo "  FAIL $1 (accepted, should be rejected)"; RC=1; }
  else [ "$4" = fail ] && echo "  PASS $1 (rejected)" || { echo "  FAIL $1 (rejected, should be accepted)"; RC=1; }; fi
}
RC=0
run "genesis -> block 1 (valid pair)" $GEN $B1 ok
run "block 1 -> genesis (wrong order)" $B1 $GEN fail
run "genesis -> block 1 with a changed nonce" $GEN $B1BAD fail
echo "RESULT=$RC"; exit $RC
