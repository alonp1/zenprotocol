#!/bin/bash
# Install a Zen node (no mining) in Docker on an existing Ubuntu server.
# Safe to run next to other services (e.g. Traccar): runs isolated in a container,
# capped at 1 CPU / 2 GB RAM, API only on localhost, P2P on port 9655.
#
# Usage:  bash setup-zen-node-server.sh
set -euo pipefail

DIR="$HOME/zenprotocol"
BRANCH="node-upgrade-script"

echo "== Checks"
FREE_GB=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc '0-9')
echo "free disk: ${FREE_GB}G"
[ "$FREE_GB" -ge 20 ] || { echo "Need at least 20 GB free disk. Aborting."; exit 1; }
for p in 9655 11567; do
  if sudo ss -tlnp | grep -q ":$p "; then echo "Port $p already in use. Aborting."; exit 1; fi
done

echo "== Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi
docker compose version >/dev/null 2>&1 || sudo apt-get install -y docker-compose-plugin

echo "== Code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout "$BRANCH" && git -C "$DIR" pull --ff-only
else
  git clone -b "$BRANCH" https://github.com/alonp1/zenprotocol.git "$DIR"
fi
cd "$DIR"

echo "== Firewall"
if sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 9655/tcp comment 'zen-node p2p'
else
  echo "ufw not active - if you use the Hetzner Cloud Firewall, allow inbound TCP 9655 there."
fi

echo "== Start node (mining OFF)"
EXTERNAL_IP=$(curl -fs https://api.ipify.org || true)
echo "EXTERNAL_IP=$EXTERNAL_IP" > .env
echo "MINER_THREADS=0" >> .env
sudo docker compose up -d --build

echo "== Waiting 60s for the API..."
sleep 60
curl -s http://127.0.0.1:11567/blockchain/info || echo "Not up yet. Watch: cd $DIR && sudo docker compose logs -f"
echo
echo "Status any time:  curl -s http://127.0.0.1:11567/blockchain/info"
echo "Logs:             cd $DIR && sudo docker compose logs -f --tail 50"
