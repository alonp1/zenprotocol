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

rm -rf "$STAGE" && mkdir -p "$STAGE/zen-node/$CHAIN" "$OUT"
cp -a "$SRC" "$STAGE/zen-node/$CHAIN/"
# contracts folder (compiled contracts) speeds up startup; include if present
[ -d "$DATA/$CHAIN/contracts" ] && cp -a "$DATA/$CHAIN/contracts" "$STAGE/zen-node/$CHAIN/" || true
# address index (if this node runs with WALLET_API/PUBLIC_NODE) saves hours of indexing
[ -d "$DATA/$CHAIN/addressdb" ] && cp -a "$DATA/$CHAIN/addressdb" "$STAGE/zen-node/$CHAIN/" || true
# make sure no wallet data slipped in
find "$STAGE" -iname "*wallet*" -prune -exec rm -rf {} +

echo "== Zipping"
(cd "$STAGE" && zip -qr -9 "$OUT/$NAME.zip" zen-node)
rm -rf "$STAGE"

(cd "$OUT" && sha256sum "$NAME.zip" > "$NAME.zip.sha256")
ls -lh "$OUT/$NAME.zip"
cat "$OUT/$NAME.zip.sha256"
echo "== Done: $OUT/$NAME.zip"
