#!/bin/bash
# Load the official Zen Protocol blockchain snapshot (Feb 2023, ~1.8 GB) into /data,
# so the node only has to sync blocks from 2023 onwards. The wallet is never touched.
#
# Run with the node STOPPED, from the zenprotocol folder:
#   docker compose down
#   docker compose run --rm --no-deps --entrypoint /load-snapshot.sh zen-node
#   docker compose up -d
set -euo pipefail

URL="${SNAPSHOT_URL:-https://node-backups.s3-eu-west-1.amazonaws.com/zen-node.zip}"
DATA=/data
TMP="$DATA/.snapshot-tmp"
CHAIN="${CHAIN:-main}"

mkdir -p "$TMP"
cd "$TMP"

echo "== Downloading snapshot (resumable)"
curl -fL -C - -o zen-node.zip "$URL"

echo "== Checking archive"
unzip -tq zen-node.zip

echo "== Extracting"
rm -rf extract && mkdir extract
unzip -q zen-node.zip -d extract

SRC=$(find extract -type d -name blockchain -path "*/$CHAIN/blockchain" | head -1)
[ -n "$SRC" ] || { echo "No $CHAIN/blockchain folder found in the snapshot:"; find extract -maxdepth 4 -type d; exit 1; }
SRC_CHAIN=$(dirname "$SRC")
echo "snapshot chain folder: $SRC_CHAIN"
ls "$SRC_CHAIN"

echo "== Replacing chain data (wallet kept)"
mkdir -p "$DATA/$CHAIN"
for d in blockchain contracts addressdb; do
  if [ -d "$SRC_CHAIN/$d" ]; then
    rm -rf "${DATA:?}/$CHAIN/$d"
    mv "$SRC_CHAIN/$d" "$DATA/$CHAIN/$d"
    echo "loaded $d"
  fi
done

cd "$DATA" && rm -rf "$TMP"
echo "== Done. Start the node: docker compose up -d"
