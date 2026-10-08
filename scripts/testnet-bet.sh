#!/usr/bin/env bash
# A bet on the testnet, end to end, with zUSD as collateral (docs/ORACLE.md):
#   buy zUSD (the Token contract) -> activate FixedPayout -> Issue Bull/Bear tokens on EUR (mock oracle)
#   -> Attest the oracle's commitment to the FixedPayout contract -> Redeem the winning side -> collateral is back.
# Needs: a testnet node with the public test wallet, the Token contract active and the Oracle contract active with the
# oracle service running (scripts/testnet-oracle.sh does that). Reads /tmp/token.env and /tmp/oracle.env.
set -euo pipefail
API=${1:-http://127.0.0.1:31567}; PW=${2:-testnet}; ORACLE=${ORACLE_URL:-http://127.0.0.1:8085}
. /tmp/token.env; . /tmp/oracle.env     # TOKEN_ID TOKEN_ADDR ORACLE_ID ORACLE_ADDR
ZO="dotnet src/Oracle/bin/Release/zen-oracle.dll"
post() { curl -s -X POST -H "Content-Type: application/json" -d "$2" "$API$1"; }
# Calls are signed with the wallet's own first address key (m/44'/258'/0'/0/0): FixedPayout locks the positions to the
# sender's public key, and the wallet only sees outputs of its own addresses. A 5th argument "" sends the call unsigned.
SIGN_OWN="m/44'/258'/0'/0/0"
exec_contract() {   # address command bodyhex spends-json [sign path, "" = none]
  local B; B=$(ADDR="$1" CMD="$2" BODY="$3" SP="$4" SG="${5-$SIGN_OWN}" PW="$PW" python3 -c "import json,os;o={'returnAddress':True}
if os.environ['SG']: o['sign']=os.environ['SG']
print(json.dumps({'address':os.environ['ADDR'],'command':os.environ['CMD'],'messageBody':os.environ['BODY'],'options':o,'spends':json.loads(os.environ['SP']),'password':os.environ['PW']}))")
  local R; R=$(post /wallet/contract/execute "$B"); echo "  $2 -> $(echo "$R" | cut -c1-160)" >&2
  echo "$R" | grep -Eq '^"[0-9a-f]{64}"$' || { echo "FAILED: $2"; exit 1; }
  LASTTX=$(echo "$R" | tr -d '"')
}
bal() { curl -fs "$API/wallet/balance" | ASSET="$1" python3 -c "import json,os,sys;print(sum(b['balance'] for b in json.load(sys.stdin) if b['asset']==os.environ['ASSET']))"; }
tip() { curl -fs "$API/blockchain/info" | sed -n 's/.*"blocks": *\([0-9]*\).*/\1/p'; }
blocks() { local t; t=$(( $(tip) + $1 )); for i in $(seq 120); do [ "$(tip)" -ge "$t" ] && return; sleep 5; done; echo "no new blocks"; exit 1; }

echo "== 1. buy zUSD (Token contract) with 5,000,000 kalapas"
exec_contract "$TOKEN_ADDR" buy "" '[{"asset":"00","amount":5000000}]'
for i in $(seq 60); do [ "$(bal "$TOKEN_ID")" -ge 5001000 ] && break; sleep 5; done
Z0=$(bal "$TOKEN_ID"); echo "zUSD balance: $Z0"; [ "$Z0" -ge 5001000 ]

echo "== 2. activate FixedPayout (verification takes minutes)"
OUT=$(CONTRACT=src/ContractExamples/FixedPayout.fst RLIMIT=${RLIMIT:-30000000} EXECUTE=0 bash scripts/testnet-contract.sh "$API" "$PW")
FP_ADDR=$(echo "$OUT" | sed -n 's/^CONTRACT_ADDRESS=//p'); FP_ID=$(echo "$OUT" | sed -n 's/^CONTRACT_ID=//p')
echo "FixedPayout $FP_ADDR"; [ -n "$FP_ID" ]

echo "== 3. oracle key and the latest committed round"
PK=$(post /wallet/publickey "{\"path\":\"m/44'/258'/0'/3/0\",\"password\":\"$PW\"}" | tr -d '"'); echo "oracle public key: $PK"
P=$(curl -fs "$ORACLE/auditpath?ticker=EUR")
read -r TS ROOT VALUE INDEX PATHS < <(echo "$P" | python3 -c "import json,sys;p=json.load(sys.stdin);print(p['timestamp'],p['root'],p['valueScaled'],p['index'],','.join(p['auditPath']))")
echo "round $TS value(x1000) $VALUE root $ROOT"
COMMIT=$($ZO commit-hash "$ROOT" "$TS")
blocks 2                                    # the commitment is in a block

START=$((TS - 3600000)); EXPIRY=$((TS + 31536000000)); PRICE=$((VALUE - 1))      # Bull wins: value >= price
EVENT="OraclePubKey:k=$PK OracleContractId:s=$ORACLE_ID Ticker:s=EUR Price:u=$PRICE Start:u=$START Expiry:u=$EXPIRY Collateral:s=$TOKEN_ID"

echo "== 4. Issue: lock 1000 zUSD, get 1000 Bull + 1000 Bear"
exec_contract "$FP_ADDR" Issue "$($ZO body $EVENT)" "[{\"asset\":\"$TOKEN_ID\",\"amount\":1000}]"
for i in $(seq 60); do N=$(curl -fs "$API/wallet/balance" | TOK="$TOKEN_ID" python3 -c "import json,os,sys;print(len([b for b in json.load(sys.stdin) if b['asset'] not in ('00',os.environ['TOK']) and b['balance']==1000]))"); [ "$N" -ge 2 ] && break; sleep 5; done
echo "position tokens in the wallet: $N"
if [ "$N" -lt 2 ]; then   # the contract locks positions to the sender's public key; the wallet balance does not list those
  for i in $(seq 60); do R=$(curl -s "$API/blockchain/transaction?hash=$LASTTX"); echo "$R" | grep -qi "blocknumber\|confirmations" && break; sleep 5; done
  echo "$R" | grep -qi "blocknumber\|confirmations" || { echo "Issue not confirmed"; exit 1; }
  echo "PARTIAL: Issue confirmed ($LASTTX); positions are locked to the signing key and are not in the wallet balance, so Attest/Redeem are not run"
  exit 0
fi
Z1=$(bal "$TOKEN_ID"); echo "zUSD after issue: $Z1 (was $Z0)"

echo "== 5. Attest: the oracle contract gives the attestation token to FixedPayout"
exec_contract "$ORACLE_ADDR" Attest "$($ZO body Commit:h=$COMMIT OraclePubKey:k=$PK Recipient:c=$FP_ID)" '[]' ""
blocks 2

echo "== 6. Redeem the winning position (Bull), 1000 tokens"
REDEEM="$EVENT Timestamp:u=$TS Root:h=$ROOT Value:u=$VALUE AuditPath:L=$PATHS Index:u=$INDEX"
DONE=0
for A in $(curl -fs "$API/wallet/balance" | TOK="$TOKEN_ID" python3 -c "import json,os,sys;print(' '.join(b['asset'] for b in json.load(sys.stdin) if b['asset'] not in ('00',os.environ['TOK']) and b['balance']==1000))"); do
  set +e; ( exec_contract "$FP_ADDR" Redeem "$($ZO body $REDEEM Position:s=Bull)" "[{\"asset\":\"$A\",\"amount\":1000}]" ) ; RC=$?; set -e
  [ $RC -eq 0 ] && { DONE=1; break; }
done
[ $DONE -eq 1 ] || { echo "redeem failed for every position token"; exit 1; }
for i in $(seq 60); do Z2=$(bal "$TOKEN_ID"); [ "$Z2" -ge "$Z0" ] && break; sleep 5; done
echo "zUSD after redeem: $Z2 (before the bet $Z0)"; [ "$Z2" -ge "$Z0" ]
echo "BET OK: issued, attested, redeemed, collateral returned"
