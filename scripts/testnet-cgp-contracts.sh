#!/usr/bin/env bash
# Testnet: activate the CGP and voting contracts, so CGP ballots (nomination, allocation, payout vote) and the payout can be tried.
# The testnet parameters already name them (cgpContractId, votingContractId in Consensus/Chain.fs). A contract id is
# SHA3-256(version || code), so the files below are exactly the code those ids were made from (checked by this script).
# The node wallet pays the activation (about 10 ZP for 100,000 blocks); the node must follow the testnet and have mined ZP.
# usage: scripts/testnet-cgp-contracts.sh [api-url] [password] [blocks]      (run on the testnet server, in the repo)
set -euo pipefail
API=${1:-http://127.0.0.1:31567}; PW=${2:-testnet}; BLOCKS=${3:-100000}
CGP_ID=00000000eac6c58bed912ff310df9f6960e8ed5c28aac83b8a98964224bab1e06c779b93
VOTING_ID=00000000e89738718a802a7d217941882efe8e585e20b20901391bc37af25fac2f22c8ab
activate() {   # name file expected-id rlimit
  local name=$1 file=$2 want=$3 rl=$4
  local got; got=00000000$(python3 -c "import hashlib,sys;print(hashlib.sha3_256(b'\0\0\0\0'+open(sys.argv[1],'rb').read()).hexdigest())" "$file")
  [ "$got" = "$want" ] || { echo "$name: the file does not match the id in Chain.fs ($got)"; exit 1; }
  if curl -fs "$API/contract/active" | grep -q "$want"; then echo "$name: already active"; return; fi
  local body out
  body=$(F="$file" PW="$PW" B="$BLOCKS" R="$rl" python3 -c "import json,os;print(json.dumps({'code':open(os.environ['F']).read(),'numberOfBlocks':int(os.environ['B']),'password':os.environ['PW'],'rlimit':int(os.environ['R'])}))")
  out=$(curl -s -X POST -H "Content-Type: application/json" -d "$body" "$API/wallet/contract/activate"); echo "$name: $(echo "$out" | cut -c1-200)"
  echo "$out" | grep -q "$want" || { echo "$name: activation failed"; exit 1; }
}
activate voting src/ContractExamples/TestnetVoting.fst "$VOTING_ID" 2000000
activate CGP    src/ContractExamples/TestnetCGP.fst    "$CGP_ID"    30000000
echo "== waiting for both to become active (each needs a block)"
for i in $(seq 180); do
  A=$(curl -fs "$API/contract/active" || true)
  echo "$A" | grep -q "$VOTING_ID" && echo "$A" | grep -q "$CGP_ID" && { echo "both active after $((i*10)) s"; exit 0; }
  sleep 10
done
echo "not both active after 30 minutes: $(echo "$A" | cut -c1-200)"; exit 1
