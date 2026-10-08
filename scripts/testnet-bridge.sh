#!/usr/bin/env bash
# USDC bridge prototype on the testnet, deposit side, with a mock EVM chain (docs/BRIDGE.md):
#   activate AuthenticatedSupply (the bridge key is the only issuer) -> start site/bridge/bridge.mjs
#   -> a deposit of 25 USDC from an EVM address appears in a mock file -> the owner links a ZP address
#   -> the bridge issues 25,000,000 zUSDC units to it. Needs the built oracle project (body command) and wallet/node_modules.
set -euo pipefail
API=${1:-http://127.0.0.1:31567}; PW=${2:-testnet}
SIGN="m/44'/258'/0'/3/0"
post() { curl -s -X POST -H "Content-Type: application/json" -d "$2" "$API$1"; }
bal() { curl -fs "$API/wallet/balance" | ASSET="$1" python3 -c "import json,os,sys;print(sum(b['balance'] for b in json.load(sys.stdin) if b['asset']==os.environ['ASSET']))"; }
PK=$(post /wallet/publickey "{\"path\":\"$SIGN\",\"password\":\"$PW\"}" | tr -d '"')
sed "s/^let authenticatedPubKey = \"\"/let authenticatedPubKey = \"$PK\"/" src/ContractExamples/AuthenticatedSupply.fst > /tmp/AuthenticatedSupply.fst
echo "== activate AuthenticatedSupply with the bridge key"
OUT=""
for R in 8000000 30000000; do
  OUT=$(CONTRACT=/tmp/AuthenticatedSupply.fst RLIMIT=$R EXECUTE=0 bash scripts/testnet-contract.sh "$API" "$PW" 2>&1) && break || echo "  limit $R failed"
done
ADDR=$(echo "$OUT" | sed -n 's/^CONTRACT_ADDRESS=//p'); ID=$(echo "$OUT" | sed -n 's/^CONTRACT_ID=//p'); echo "contract $ADDR"; [ -n "$ID" ]
USER_ZP=$(curl -fs "$API/wallet/address" | tr -d '"'); echo "user ZP address $USER_ZP"
mkdir -p /tmp/bridge && rm -rf /tmp/bridge/*
EVM=0x1111111111111111111111111111111111111111
echo "[{\"tx\":\"0xabc\",\"log\":0,\"from\":\"$EVM\",\"amount\":\"25000000\",\"block\":1}]" > /tmp/bridge/evm.json
echo "== start the bridge (mock EVM)"
BRIDGE_NODE=$API BRIDGE_CONTRACT=$ADDR BRIDGE_ASSET=$ID BRIDGE_PASSWORD=$PW BRIDGE_EVM=mock:/tmp/bridge/evm.json BRIDGE_DATA=/tmp/bridge/data BRIDGE_INTERVAL=5 \
  nohup node site/bridge/bridge.mjs > /tmp/bridge/log.txt 2>&1 &
for i in $(seq 20); do curl -fs http://127.0.0.1:8090/status >/dev/null && break; sleep 1; done
echo "== the depositor links a ZP address (deposit waits until then)"
sleep 8; curl -s http://127.0.0.1:8090/status; echo
curl -s -X POST -d "{\"evm\":\"$EVM\",\"zp\":\"$USER_ZP\",\"message\":\"Link $EVM to $USER_ZP\",\"signature\":\"mock\"}" http://127.0.0.1:8090/link; echo
echo "== wait for zUSDC to be issued"
for i in $(seq 60); do [ "$(bal "$ID")" = "25000000" ] && break; sleep 5; done
echo "zUSDC balance: $(bal "$ID")"; tail -n 5 /tmp/bridge/log.txt
curl -s http://127.0.0.1:8090/status; echo
[ "$(bal "$ID")" = "25000000" ]
echo "BRIDGE OK: deposit of 25 USDC issued 25,000,000 zUSDC units"
