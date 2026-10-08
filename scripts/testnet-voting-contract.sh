#!/usr/bin/env bash
# Testnet: activate the voting contract, so CGP ballots (nomination, allocation, payout vote) can be tried.
# The testnet already expects this contract (votingContractId in Consensus/Chain.fs): the id is the hash of the code,
# so the code must be byte for byte the stub the id was made from (src/ContractExamples/TestnetVoting.fst).
# The node wallet pays the activation; the node must follow the testnet and have mined some ZP.
# usage: scripts/testnet-voting-contract.sh [api-url] [password] [blocks]
set -euo pipefail
API=${1:-http://127.0.0.1:31567}; PW=${2:-testnet}; BLOCKS=${3:-100000}
EXPECT=00000000e89738718a802a7d217941882efe8e585e20b20901391bc37af25fac2f22c8ab
CODE=src/ContractExamples/TestnetVoting.fst
curl -fs "$API/contract/active" | grep -q "$EXPECT" && { echo "already active: $EXPECT"; exit 0; }
BODY=$(CODE="$CODE" PW="$PW" BLOCKS="$BLOCKS" python3 -c "import json,os;print(json.dumps({'code':open(os.environ['CODE']).read(),'numberOfBlocks':int(os.environ['BLOCKS']),'password':os.environ['PW']}))")
OUT=$(curl -s -X POST -H "Content-Type: application/json" -d "$BODY" "$API/wallet/contract/activate"); echo "$OUT" | cut -c1-300
CID=$(echo "$OUT" | python3 -c "import json,sys;print(json.load(sys.stdin)['contractId'])") || { echo "activation failed"; exit 1; }
[ "$CID" = "$EXPECT" ] && echo "id matches the testnet parameters" || echo "ID DIFFERS: node uses $CID in the parameters? expected $EXPECT - tell Claude"
for i in $(seq 120); do curl -fs "$API/contract/active" | grep -q "$CID" && { echo "active after $((i*10)) s"; exit 0; }; sleep 10; done
echo "not active yet after 20 minutes (needs a block: is the testnet mining?)"; exit 1
