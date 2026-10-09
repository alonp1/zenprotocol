#!/bin/bash
# CGP payout helper. In the block where a CGP winner is paid, the block must contain a transaction that executes the CGP
# contract ("Payout"). The node does NOT make it by itself: its block template logs "You should create your own contract
# execution" and every mined block is rejected with "No payout Tx" until someone sends it. The chain waits for it.
# Run this on a node that has a wallet with a little ZP (the same node a miner uses is fine).
#
#   bash scripts/cgp-payout.sh [api-url] [wallet-password]      testnet: password "testnet"; the mainnet password is your own
#
# It does nothing unless a payout is due: it shows the winner (blockchain/cgp) and sends the transaction only when the next
# block is the payout block (block number % interval == coinbase maturity, e.g. 10 on the testnet, 100 on mainnet).
set -euo pipefail
API="${1:-http://127.0.0.1:31567}"; PW="${2:-testnet}"
INFO=$(curl -fs -m 10 "$API/blockchain/info"); TIP=$(echo "$INFO" | sed -n 's/.*"blocks": *\([0-9]*\).*/\1/p')
CHAIN=$(echo "$INFO" | sed -n 's/.*"chain": *"\([a-z]*\)".*/\1/p')
if [ "$CHAIN" = testnet ]; then INTERVAL=100; MATURITY=10; else INTERVAL=10000; MATURITY=100; fi
CGP=$(curl -fs -m 10 "$API/blockchain/cgp"); echo "tip $TIP, cgp: $CGP"
echo "$CGP" | grep -q '"payout":{' || { echo "no payout winner this interval: nothing to do"; exit 0; }
NEXT=$((TIP + 1))
[ $((NEXT % INTERVAL)) -eq "$MATURITY" ] || { echo "block $NEXT is not the payout block (it is the block with number % $INTERVAL = $MATURITY): run again closer, at tip $((TIP - TIP % INTERVAL + MATURITY - 1))"; exit 0; }
echo "block $NEXT pays the winner: sending the CGP execution"
curl -s -X POST -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" "$API/wallet/contract/cgp"; echo
