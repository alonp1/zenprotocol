#!/bin/bash
# Install a ZP node in one command (Linux server or home computer with Docker; macOS with Docker Desktop):
#
#   curl -fsSL https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/scripts/install-node.sh | bash
#
# What it does: checks disk and ports, installs Docker if missing (Linux), fetches the code, pulls the ready
# node image (or builds it when the registry is unreachable), loads the newest verified chain snapshot, starts
# the node and shows the sync status. Re-running it updates the code and restarts; the chain data is kept.
#
# Options (environment variables):
#   MINER_THREADS=2   mine with 2 CPU threads (own hardware only: cloud providers forbid mining)
#   PUBLIC_NODE=1     serve other users' wallets (server; see docs/SETUP.md)
#   SKIP_SNAPSHOT=1   sync from the network instead of loading a snapshot (takes many hours)
#   DIR=...           install folder (default ~/zenprotocol)
set -euo pipefail

DIR="${DIR:-$HOME/zenprotocol}"
BRANCH="node-upgrade-script"
REPO="https://github.com/alonp1/zenprotocol.git"
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

echo "== Checks"
FREE_GB=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc '0-9')
echo "free disk: ${FREE_GB}G (needs 20)"
[ "$FREE_GB" -ge 20 ] || { echo "Need at least 20 GB free disk. Aborting."; exit 1; }
if [ ! -d "$DIR/.git" ]; then   # first install: the ports must be free
  for p in 9655 11567; do
    if $SUDO ss -tln 2>/dev/null | grep -q ":$p "; then echo "Port $p is already in use. Aborting."; exit 1; fi
  done
fi

echo "== Docker"
if ! command -v docker >/dev/null; then
  [ "$(uname)" = "Linux" ] || { echo "Install Docker Desktop first: https://www.docker.com/products/docker-desktop/"; exit 1; }
  curl -fsSL https://get.docker.com | $SUDO sh
fi
D="$SUDO docker"; docker info >/dev/null 2>&1 && D="docker"
$D compose version >/dev/null 2>&1 || $SUDO apt-get install -y docker-compose-plugin

echo "== Code"
command -v git >/dev/null || $SUDO apt-get install -y git
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q --ff-only
else git clone -q -b "$BRANCH" "$REPO" "$DIR"; fi
cd "$DIR"

echo "== Firewall"
if command -v ufw >/dev/null && $SUDO ufw status | grep -q "Status: active"; then $SUDO ufw allow 9655/tcp comment 'zen-node p2p' >/dev/null
else echo "If a cloud firewall is used, allow inbound TCP 9655 there."; fi

echo "== Settings"
EXTERNAL_IP=$(curl -fs -m 10 https://api.ipify.org || true)
{ echo "EXTERNAL_IP=$EXTERNAL_IP"; echo "MINER_THREADS=${MINER_THREADS:-0}"; echo "PUBLIC_NODE=${PUBLIC_NODE:-0}"; } > .env
# Docker Desktop (macOS): a folder is slow for the database, use a volume
[ "$(uname)" = "Darwin" ] && echo "ZEN_DATA=zen-data" >> .env

echo "== Node image"
$D compose pull zen-node 2>/dev/null || { echo "Registry not reachable: building the image here (10-20 minutes)"; $D compose build; }

if [ "${SKIP_SNAPSHOT:-0}" != "1" ] && [ ! -d "${ZEN_DATA:-$DIR/zen-data}/main/blockchaindb" ]; then
  echo "== Chain snapshot (about 2.5 GB, checked against its sha256)"
  $D compose run --rm --no-deps --entrypoint /load-snapshot.sh zen-node
fi

echo "== Start"
$D compose up -d
echo "Waiting for the API..."
for i in $(seq 1 30); do curl -fs -m 3 http://127.0.0.1:11567/blockchain/info >/dev/null 2>&1 && break; sleep 4; done
curl -s http://127.0.0.1:11567/blockchain/info || echo "Not up yet: cd $DIR && $D compose logs -f --tail 50"
cat <<MSG

Node installed in $DIR.
  Status:  curl -s http://127.0.0.1:11567/blockchain/info   (synced when "blocks" equals "headers")
  Logs:    cd $DIR && $D compose logs -f --tail 50
  Update:  run this command again
  Mining:  see docs/SETUP.md (own hardware only)
MSG
