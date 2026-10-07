#!/bin/bash
# Start a ZP testnet node that stays online (a seed), on a server with Docker (installed if missing).
#
#   curl -fsSL https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/scripts/install-testnet-seed.sh | bash
#
# Options (environment variables):
#   SEEDS=zen.sealinkgps.com   other seeds to connect to (host or ip:port, comma separated); default: network.json
#   MINER_THREADS=0            mine with N CPU threads (own hardware only: cloud providers forbid mining)
#   DIR=...                    install folder (default ~/zenprotocol-testnet)
# It runs next to a mainnet node on the same machine (different ports: testnet P2P 29555, API 127.0.0.1:31567).
# Then add the server to testnetSeeds in network.json (docs/TESTNET.md, "Moving or adding a seed").
set -euo pipefail

DIR="${DIR:-$HOME/zenprotocol-testnet}"
BRANCH="node-upgrade-script"
REPO="https://github.com/alonp1/zenprotocol.git"
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

echo "== Docker"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | $SUDO sh; fi
D="$SUDO docker"; docker info >/dev/null 2>&1 && D="docker"
$D compose version >/dev/null 2>&1 || $SUDO apt-get install -y docker-compose-plugin

echo "== Code"
command -v git >/dev/null || $SUDO apt-get install -y git
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q --ff-only
else git clone -q -b "$BRANCH" "$REPO" "$DIR"; fi
cd "$DIR"

echo "== Firewall"
if command -v ufw >/dev/null && $SUDO ufw status | grep -q "Status: active"; then $SUDO ufw allow 29555/tcp comment 'zen testnet p2p' >/dev/null
else echo "If a cloud firewall is used, allow inbound TCP 29555 there."; fi

echo "== Settings"
EXTERNAL_IP=$(curl -fs -m 10 https://api.ipify.org || true)
{ echo "EXTERNAL_IP=$EXTERNAL_IP"; echo "MINER_THREADS=${MINER_THREADS:-0}"; echo "SEEDS=${SEEDS:-}"; } > .env
echo "public address: ${EXTERNAL_IP:-unknown}"

echo "== Node image"
$D compose -f docker-compose.testnet.yml pull zen-testnet 2>/dev/null || { echo "Image not in the registry: building here (10-20 minutes)"; $D compose -f docker-compose.testnet.yml build; }

echo "== Start"
$D compose -f docker-compose.testnet.yml up -d
for i in $(seq 1 30); do curl -fs -m 3 http://127.0.0.1:31567/blockchain/info >/dev/null 2>&1 && break; sleep 4; done
curl -s http://127.0.0.1:31567/blockchain/info | head -c 400 || echo "Not up yet: cd $DIR && $D compose -f docker-compose.testnet.yml logs -f --tail 50"
cat <<MSG

Testnet node installed in $DIR (public ${EXTERNAL_IP:-?}:29555).
  Status:  curl -s http://127.0.0.1:31567/blockchain/info
  Logs:    cd $DIR && $D compose -f docker-compose.testnet.yml logs -f --tail 50
  Update:  run this command again
Next: add "${EXTERNAL_IP:-<ip>}" (or its host name) to testnetSeeds in network.json and push, so every node finds it.
MSG
