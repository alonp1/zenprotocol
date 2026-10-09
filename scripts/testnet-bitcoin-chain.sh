#!/usr/bin/env bash
# BitZen step T3: activate BitcoinHeaderChain.fst (headers kept in contract state).
# usage: scripts/testnet-bitcoin-chain.sh [api-url] [password]
set -uo pipefail
API=${1:-http://127.0.0.1:31567}; PW=${2:-testnet}
echo "== activate BitcoinHeaderChain.fst (F* verifies it: this takes minutes)"
CONTRACT=src/ContractExamples/BitcoinHeaderChain.fst EXECUTE=0 NUMBLOCKS=${NUMBLOCKS:-300} ERRCHARS=6000 bash scripts/testnet-contract.sh "$API" "$PW" | tee /tmp/btc-chain-activate.txt
ADDR=$(sed -n 's/^CONTRACT_ADDRESS=//p' /tmp/btc-chain-activate.txt | head -1)
[ -n "$ADDR" ] || { echo "activation failed"; exit 1; }
echo "ACTIVATED $ADDR"
