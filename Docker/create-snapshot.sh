#!/bin/bash
# Create a blockchain snapshot from this node's data (wallet is NEVER included).
# Layout matches the official snapshot, so load-snapshot.sh can load it.
#
# Run with the node STOPPED (the database must not change while zipping):
#   docker compose down
#   docker compose run --rm --no-deps --entrypoint /create-snapshot.sh zen-node
#   docker compose up -d
# Output: /data/snapshots/zen-node-<date>-<height>.zip + .sha256
set -euo pipefail

DATA=/data
CHAIN="${CHAIN:-main}"
OUT="$DATA/snapshots"
SRC="$DATA/$CHAIN/blockchaindb"

[ -d "$SRC" ] || { echo "No $SRC - is the node synced?"; exit 1; }

# height: read from the node log is not available offline, so take it as an argument or 'latest'
HEIGHT="${1:-latest}"
NAME="zen-node-$(date -u +%Y%m%d)-$HEIGHT"
STAGE="$OUT/.stage"

# stage = symlinks only (zip follows them), so no second copy of the data is needed on disk
rm -rf "$STAGE" "$OUT/$NAME.zip" "$OUT/$NAME.zip.sha256" && mkdir -p "$STAGE/zen-node/$CHAIN" "$OUT"
ln -s "$SRC" "$STAGE/zen-node/$CHAIN/blockchaindb"
# contracts folder (compiled contracts) speeds up startup; include if present
[ -d "$DATA/$CHAIN/contracts" ] && ln -s "$DATA/$CHAIN/contracts" "$STAGE/zen-node/$CHAIN/contracts" || true
# address index (if this node runs with WALLET_API/PUBLIC_NODE) saves hours of indexing
[ -d "$DATA/$CHAIN/addressdb" ] && ln -s "$DATA/$CHAIN/addressdb" "$STAGE/zen-node/$CHAIN/addressdb" || true

need=$(du -sLk "$STAGE" | cut -f1); free=$(df -k --output=avail "$OUT" | tail -1)
echo "data $((need/1024)) MB, free $((free/1024)) MB"
[ "$free" -gt "$((need / 2))" ] || { echo "not enough free disk for the zip (needs about half the data size)"; rm -rf "$STAGE"; exit 1; }

echo "== Zipping"
# never include wallet data
(cd "$STAGE" && zip -qr -9 "$OUT/$NAME.zip" zen-node -x '*wallet*' '*Wallet*')
rm -rf "$STAGE"

(cd "$OUT" && sha256sum "$NAME.zip" > "$NAME.zip.sha256")
ls -lh "$OUT/$NAME.zip"
cat "$OUT/$NAME.zip.sha256"
echo "== Done: $OUT/$NAME.zip"
