#!/usr/bin/env bash
# Oracle on the testnet: activate the Oracle contract, run one oracle round (mock data) against it,
# check the commitment transaction is in a block and the proof endpoint answers.
# needs: a testnet node with the public test wallet, dotnet 10, the oracle built (src/Oracle/bin/Release)
set -euo pipefail
API=${1:-http://127.0.0.1:31567}; PW=${2:-testnet}
OUT=$(CONTRACT=src/ContractExamples/Oracle.fst EXECUTE=0 bash scripts/testnet-contract.sh "$API" "$PW")
echo "$OUT" | tail -n 5
ADDR=$(echo "$OUT" | sed -n 's/^CONTRACT_ADDRESS=//p')
[ -n "$ADDR" ]
export ORACLE_NODE=$API ORACLE_CONTRACT=$ADDR ORACLE_PASSWORD=$PW ORACLE_DATA=/tmp/oracle-data ORACLE_PROVIDER=mock
rm -rf /tmp/oracle-data
dotnet src/Oracle/bin/Release/zen-oracle.dll once | tee /tmp/oracle-once.txt
TX=$(sed -n 's/.* tx \([0-9a-f]\{64\}\)$/\1/p' /tmp/oracle-once.txt)
[ -n "$TX" ] || { echo "no commitment transaction"; exit 1; }
echo "== wait until the commitment is in a block"
for i in $(seq 60); do
  R=$(curl -s "$API/blockchain/transaction?hash=$TX" || true)
  echo "$R" | grep -qi "blocknumber\|confirmations" && { echo "in a block after $((i*10)) s: $(echo "$R" | cut -c1-200)"; break; }
  sleep 10
done
echo "$R" | grep -qi "blocknumber\|confirmations" || { echo "commitment not confirmed: $R" | cut -c1-300; exit 1; }
echo "== proof endpoint"
(dotnet src/Oracle/bin/Release/zen-oracle.dll run > /tmp/oracle-run.txt 2>&1 &)
for i in $(seq 20); do curl -fs "http://127.0.0.1:8085/auditpath?ticker=EURUSD" && break; sleep 2; done
