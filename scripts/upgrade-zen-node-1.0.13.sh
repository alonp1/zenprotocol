#!/bin/bash
# Upgrade an existing zen-node (installed via the old zen.sh) to 1.0.13 - the version without expiry.
# Keeps the existing blockchain + wallet in ~/.config/zen-node. Run as the same user that ran zen.sh.
#
# Usage:  bash upgrade-zen-node-1.0.13.sh            # node only
#         MINER_THREADS=2 bash upgrade-zen-node-1.0.13.sh   # node + CPU miner
set -euo pipefail

DATAPATH="$HOME/.config/zen-node"
MINER_THREADS="${MINER_THREADS:-0}"
VERSION="1.0.13"

echo "== 1. Checks"
command -v mono >/dev/null || { echo "mono not found - install mono-devel first"; exit 1; }
MONO_VER=$(mono --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
echo "mono $MONO_VER"
if [ "$(printf '%s\n6.12.0\n' "$MONO_VER" | sort -V | head -1)" != "6.12.0" ]; then
  echo "zen-node $VERSION needs mono >= 6.12 - upgrade mono first"; exit 1
fi

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
command -v npm >/dev/null || { echo "npm not found (nvm missing?)"; exit 1; }

echo "== 2. Stop the old node"
sudo systemctl stop zen-node.service 2>/dev/null || true

echo "== 3. Back up data dir (wallet + chain)"
if [ -d "$DATAPATH" ]; then
  NEED=$(du -sk "$DATAPATH" | cut -f1)
  FREE=$(df -k --output=avail "$HOME" | tail -1)
  BACKUP="$DATAPATH.bak-$(date +%Y%m%d-%H%M)"
  if [ "$FREE" -gt $((NEED + 1048576)) ]; then
    cp -a "$DATAPATH" "$BACKUP"
    echo "backup: $BACKUP"
  else
    echo "Not enough disk for a full backup ($((NEED/1024)) MB needed)."
    echo "Make sure you have your 24-word mnemonic, then press Enter to continue (Ctrl+C to abort)."
    read -r
  fi
else
  echo "no existing data dir - node will sync from scratch"
fi

echo "== 4. Install zen-node $VERSION"
npm config set @zen:registry https://www.myget.org/F/zenprotocol/npm/
npm install -g "@zen/zen-node@$VERSION"
RELEASE_DIR="$(npm root -g)/@zen/zen-node/Release"
[ -f "$RELEASE_DIR/zen-node.exe" ] || { echo "zen-node.exe not found in $RELEASE_DIR"; exit 1; }

MINER_ARG=""
[ "$MINER_THREADS" -gt 0 ] && MINER_ARG="--miner $MINER_THREADS"

echo "== 5. Write systemd service (API bound to localhost only)"
sudo tee /etc/systemd/system/zen-node.service >/dev/null <<EOF
[Unit]
Description=Zen Node $VERSION
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$RELEASE_DIR
ExecStart=$(command -v mono) $RELEASE_DIR/zen-node.exe --data-path "$DATAPATH" --api "127.0.0.1:11567" $MINER_ARG
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable zen-node.service
sudo systemctl start zen-node.service

echo "== Done. Checking in 20s..."
sleep 20
curl -s http://127.0.0.1:11567/blockchain/info || echo "API not up yet - watch: sudo journalctl -fu zen-node"
echo
echo "Follow logs: sudo journalctl -fu zen-node"
