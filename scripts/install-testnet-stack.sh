#!/bin/bash
# A whole ZP testnet server in one command: the node (a seed), the three contracts the services need, the oracle,
# the chain index and explorer API, and the USDC bridge prototype. Run as root on a fresh Ubuntu/Debian server with
# at least 4 GB RAM:
#
#   curl -fsSL https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/scripts/install-testnet-stack.sh | bash
#
# Options (environment variables):
#   MINER_THREADS=1     CPU threads the node mines with (the testnet needs a miner; difficulty is low). 0 = do not mine.
#   SEEDS=...           other testnet seeds to connect to (comma separated)
#   ORACLE_PROVIDER=mock|frankfurter|coingecko|auto   price source (default auto: currencies from Frankfurter, crypto from CoinGecko; free, no key)
#   ORACLE_TICKERS=EUR,GBP,CHF,AUD,BTC          what to publish (at most 4 characters each)
#   DIR=...             install folder (default ~/zenprotocol-testnet)
# Re-running it updates the code and restarts the services; contracts that are already recorded in
# testnet-stack.env are kept. Nothing here uses real money: the wallet phrase is the public test phrase.
set -euo pipefail

DIR="${DIR:-$HOME/zenprotocol-testnet}"
export DIR
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"
MN="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
PW=testnet
API=http://127.0.0.1:31567

echo "== 1/6 The node"
export MINER_THREADS="${MINER_THREADS:-1}" TESTNET_MNEMONIC="$MN"
curl -fsSL "https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/scripts/install-testnet-seed.sh" | bash
cd "$DIR"
grep -q TESTNET_MNEMONIC .env || echo "TESTNET_MNEMONIC=$MN" >> .env
grep -q '^MINER_THREADS=' .env && sed -i "s/^MINER_THREADS=.*/MINER_THREADS=$MINER_THREADS/" .env
D="$SUDO docker"; docker info >/dev/null 2>&1 && D="docker"
$D compose -f docker-compose.testnet.yml up -d
command -v python3 >/dev/null || $SUDO apt-get install -y python3

echo "== 2/6 Wait for the first blocks (the wallet needs mined coins to activate contracts)"
tip() { curl -fs -m 5 $API/blockchain/info | sed -n 's/.*"blocks": *\([0-9]*\).*/\1/p'; }
for i in $(seq 180); do T=$(tip || true); [ -n "$T" ] && [ "$T" -ge 20 ] && break; sleep 10; done
[ -n "${T:-}" ] && [ "$T" -ge 20 ] || { echo "The node has not reached block 20 (tip ${T:-none}). Check: cd $DIR && $D compose -f docker-compose.testnet.yml logs --tail 40"; exit 1; }
echo "tip $T"

echo "== 3/6 Build the tools image (oracle + body tool, 5-10 minutes the first time)"
$D build -f Docker/Dockerfile.tools -t zen-tools .
for d in wallet site/bridge; do
  $D run --rm -v "$DIR:/r" -w /r/$d node:22-alpine sh -c "$( [ $d = wallet ] && echo 'npm ci --no-audit --no-fund' || echo 'npm install --no-audit --no-fund' )"
done
ZO() { $D run --rm --network host -v "$DIR:/r" zen-tools dotnet /app/zen-oracle.dll "$@"; }

echo "== 4/6 Contracts (each is verified on activation: a few minutes)"
touch testnet-stack.env
get() { sed -n "s/^$1=//p" testnet-stack.env | tail -1; }
put() { grep -v "^$1=" testnet-stack.env > testnet-stack.tmp || true; echo "$1=$2" >> testnet-stack.tmp; mv testnet-stack.tmp testnet-stack.env; }
activate() {   # file name-of-variable-prefix
  local OUT
  for R in 8000000 30000000; do
    OUT=$(NUMBLOCKS=${NUMBLOCKS:-50000} CONTRACT=$1 RLIMIT=$R EXECUTE=0 bash scripts/testnet-contract.sh "$API" "$PW" 2>&1) && break || { echo "  z3 limit $R failed"; OUT=""; }
  done
  [ -n "$OUT" ] || { echo "activation of $1 failed"; return 1; }
  put "$2_ADDRESS" "$(echo "$OUT" | sed -n 's/^CONTRACT_ADDRESS=//p')"; put "$2_ID" "$(echo "$OUT" | sed -n 's/^CONTRACT_ID=//p')"
}
if [ -z "$(get ORACLE_ID)" ]; then echo "-- Oracle"; activate src/ContractExamples/Oracle.fst ORACLE; fi
PK=$(curl -s -X POST -H "Content-Type: application/json" -d "{\"path\":\"m/44'/258'/0'/3/0\",\"password\":\"$PW\"}" $API/wallet/publickey | tr -d '"')
if [ -z "$(get BRIDGE_ID)" ]; then echo "-- AuthenticatedSupply (zUSDC, bridge key)"
  sed "s/^let authenticatedPubKey = \"\"/let authenticatedPubKey = \"$PK\"/" src/ContractExamples/AuthenticatedSupply.fst > /tmp/AuthenticatedSupply.fst
  activate /tmp/AuthenticatedSupply.fst BRIDGE; fi
if [ -z "$(get DEX_ID)" ]; then echo "-- ZenDex"; activate src/ContractExamples/Dex.fst DEX; fi
put ORACLE_CONTRACT "$(get ORACLE_ADDRESS)"
put BRIDGE_CONTRACT "$(get BRIDGE_ADDRESS)"; put BRIDGE_ASSET "$(get BRIDGE_ID)"
put ZEN_DEX "$(get DEX_ID)"; put ZEN_NET test
[ -n "$(get ORACLE_PROVIDER)" ] || put ORACLE_PROVIDER "${ORACLE_PROVIDER:-auto}"
[ "$(get ORACLE_PROVIDER)" = frankfurter ] && echo "$(get ORACLE_TICKERS)" | grep -q BTC && put ORACLE_PROVIDER auto   # frankfurter has no BTC
[ -n "$(get ORACLE_TICKERS)" ] || put ORACLE_TICKERS "${ORACLE_TICKERS:-EUR,GBP,CHF,AUD,BTC}"
[ -n "$(get ORACLE_QUOTE)" ] || put ORACLE_QUOTE USD
[ -n "$(get BRIDGE_EVM)" ] || put BRIDGE_EVM "mock:/data/evm.json"
chmod 600 testnet-stack.env
echo "-- recorded in $DIR/testnet-stack.env"

echo "== 5/6 Services"
$D compose -f docker-compose.testnet.yml -f docker-compose.testnet-stack.yml up -d

echo "== 6/6 Check"
sleep 20
curl -s http://127.0.0.1:8085/health; echo
curl -s http://127.0.0.1:8090/status; echo
curl -s http://127.0.0.1:11581/explorer/api/dex/orders | head -c 200; echo
cat <<MSG

Done. Contracts and settings: $DIR/testnet-stack.env
  Oracle service      127.0.0.1:8085   (/health, /rounds/latest, /auditpath)
  Explorer API        127.0.0.1:11581  (/explorer/api/...; /dex/orders, /dex/trades)
  Bridge              127.0.0.1:8090   (/status; mock EVM until BRIDGE_EVM in testnet-stack.env is a Base Sepolia RPC URL)
To publish them: nginx routes /oracle/, /explorer/api/ and /bridge/ to those ports (site/nginx-zen.conf has the oracle route).
Logs: cd $DIR && $D compose -f docker-compose.testnet.yml -f docker-compose.testnet-stack.yml logs -f --tail 40 oracle index explorer bridge
Update: run this command again.
MSG
