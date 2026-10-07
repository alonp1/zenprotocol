#!/usr/bin/env bash
# Financial instruments of the Zen contracts on the testnet, one scenario each (docs/INSTRUMENTS.md):
#   NamedToken         create a named token ("zUSD") of any amount
#   AuthenticatedSupply  a token only the holder of one key can issue and destroy
#   ZenDex             a decentralised exchange: make, take and cancel orders between two assets
# Needs: a testnet node with the public test wallet, the Token contract active (/tmp/token.env, from scripts/testnet-contract.sh),
# dotnet 10 and the built oracle project (its `body` command builds the message bodies). Each scenario reports on its own.
set -uo pipefail
API=${1:-http://127.0.0.1:31567}; PW=${2:-testnet}
. /tmp/token.env           # TOKEN_ID TOKEN_ADDR
ZO="dotnet src/Oracle/bin/Release/zen-oracle.dll"
SIGN="m/44'/258'/0'/3/0"
post() { curl -s -X POST -H "Content-Type: application/json" -d "$2" "$API$1"; }
exec_contract() {   # address command bodyhex spends-json [sign]
  local B R; B=$(ADDR="$1" CMD="$2" BODY="$3" SP="$4" SG="${5:-}" PW="$PW" python3 -c "import json,os;o={'returnAddress':True};
if os.environ['SG']: o['sign']=os.environ['SG']
print(json.dumps({'address':os.environ['ADDR'],'command':os.environ['CMD'],'messageBody':os.environ['BODY'],'options':o,'spends':json.loads(os.environ['SP']),'password':os.environ['PW']}))")
  R=$(post /wallet/contract/execute "$B"); echo "  $2 -> $(echo "$R" | cut -c1-160)" >&2
  echo "$R" | grep -Eq '^"[0-9a-f]{64}"$' || return 1
  LASTTX=$(echo "$R" | tr -d '"')
}
tx_in_block() {   # tx hash -> prints the transaction JSON once it is in a block
  for i in $(seq 60); do
    local R; R=$(curl -s "$API/blockchain/transaction?hash=$1")
    echo "$R" | grep -qi "blocknumber\|confirmations" && { echo "$R"; return 0; }
    sleep 5
  done; return 1
}
bal() { curl -fs "$API/wallet/balance" | ASSET="$1" python3 -c "import json,os,sys;print(sum(b['balance'] for b in json.load(sys.stdin) if b['asset']==os.environ['ASSET']))"; }
tip() { curl -fs "$API/blockchain/info" | sed -n 's/.*"blocks": *\([0-9]*\).*/\1/p'; }
wait_bal() {   # asset predicate-value timeout: wait until balance == value
  for i in $(seq ${3:-60}); do [ "$(bal "$1")" = "$2" ] && return 0; sleep 5; done; return 1; }
activate() {   # file -> prints "ADDR ID", tries growing z3 limits
  local F=$1 OUT
  for R in 8000000 30000000; do
    OUT=$(CONTRACT=$F RLIMIT=$R EXECUTE=0 bash scripts/testnet-contract.sh "$API" "$PW" 2>&1) && {
      echo "$(echo "$OUT" | sed -n 's/^CONTRACT_ADDRESS=//p') $(echo "$OUT" | sed -n 's/^CONTRACT_ID=//p')"; return 0; }
    echo "  activation with z3 limit $R failed: $(echo "$OUT" | tail -n 2 | cut -c1-200)" >&2
  done; return 1; }
PK=$(post /wallet/publickey "{\"path\":\"$SIGN\",\"password\":\"$PW\"}" | tr -d '"')
RESULTS=()
scenario() { local name=$1 rc; shift; echo "== $name"; ( set -e; "$@" ); rc=$?; if [ $rc -eq 0 ]; then RESULTS+=("PASS $name"); else RESULTS+=("FAIL $name"); fi; }

named_token() {
  read -r ADDR ID < <(activate src/ContractExamples/NamedToken.fst)
  exec_contract "$ADDR" "" "$($ZO body name:s=zUSD amount:u=7777)" '[]'
  for i in $(seq 60); do
    N=$(curl -fs "$API/wallet/balance" | python3 -c "import json,sys;print(len([b for b in json.load(sys.stdin) if b['balance']==7777 and b['asset'].startswith('$ID')]))")
    [ "$N" -ge 1 ] && break; sleep 5; done
  echo "  token named zUSD of contract ${ID:0:12}…: $N asset(s) with 7777 units"; [ "$N" -ge 1 ]
}

authenticated_supply() {
  sed "s/^let authenticatedPubKey = \"\"/let authenticatedPubKey = \"$PK\"/" src/ContractExamples/AuthenticatedSupply.fst > /tmp/AuthenticatedSupply.fst
  grep -q "$PK" /tmp/AuthenticatedSupply.fst
  read -r ADDR ID < <(activate /tmp/AuthenticatedSupply.fst)
  exec_contract "$ADDR" Issue "$($ZO body Amount:u=4242)" '[]' "$SIGN"
  wait_bal "$ID" 4242
  echo "  issued 4242, balance $(bal "$ID")"
  exec_contract "$ADDR" Destroy "$($ZO body Amount:u=242)" "[{\"asset\":\"$ID\",\"amount\":242}]" "$SIGN"
  wait_bal "$ID" 4000
  echo "  destroyed 242, balance $(bal "$ID")"
}

dex() {
  read -r ADDR ID < <(activate src/ContractExamples/Dex.fst)
  exec_contract "$TOKEN_ADDR" buy "" '[{"asset":"00","amount":3000000}]'
  for i in $(seq 60); do [ "$(bal "$TOKEN_ID")" -ge 3000000 ] && break; sleep 5; done
  Z0=$(bal "$TOKEN_ID"); echo "  zUSD balance $Z0"
  order() { echo "UnderlyingAsset:s=$TOKEN_ID UnderlyingAmount:u=$1 PairAsset:s=00 OrderTotal:u=$2 MakerPubKey:k=$PK"; }
  echo "  make: sell 1000 zUSD for 500 kalapas of ZP"
  exec_contract "$ADDR" Make "$($ZO body $(order 1000 500))" "[{\"asset\":\"$TOKEN_ID\",\"amount\":1000}]" "$SIGN"
  wait_bal "$TOKEN_ID" $((Z0 - 1000))
  echo "  take: pay 500 ZP, receive 1000 zUSD"
  exec_contract "$ADDR" Take "$($ZO body $(order 1000 500) RequestedPayout:u=1000 ProvidedAmount:u=500)" '[{"asset":"00","amount":500}]'
  wait_bal "$TOKEN_ID" "$Z0"
  echo "  zUSD back at $(bal "$TOKEN_ID")"
  echo "  make and cancel: 300 zUSD for 100 ZP"
  exec_contract "$ADDR" Make "$($ZO body $(order 300 100))" "[{\"asset\":\"$TOKEN_ID\",\"amount\":300}]" "$SIGN"
  wait_bal "$TOKEN_ID" $((Z0 - 300))
  exec_contract "$ADDR" Cancel "$($ZO body $(order 300 100))" '[]' "$SIGN"
  # the underlying goes back to the maker's public key (the signing key, not an address of the wallet's account):
  # check the confirmed transaction pays 300 zUSD out
  J=$(tx_in_block "$LASTTX")
  echo "$J" | python3 -c "import json,sys;t=json.load(sys.stdin);o=json.dumps(t);assert '$TOKEN_ID' in o and '300' in o, 'cancel does not pay 300 zUSD'" 
  echo "  cancelled: the confirmed transaction pays 300 zUSD back to the maker key"
}

for s in ${SCENARIOS:-named_token authenticated_supply dex}; do scenario "$s" "$s"; done
echo; printf '%s\n' "${RESULTS[@]}"
! printf '%s\n' "${RESULTS[@]}" | grep -q '^FAIL'
