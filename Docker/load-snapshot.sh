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
unzip -tq zen-node.zip || { rm -f zen-node.zip; echo "Archive is corrupt - deleted it. Run this script again to download a fresh copy."; exit 1; }

echo "== Extracting"
rm -rf extract && mkdir extract
unzip -q zen-node.zip -d extract

# the chain folder holds blockchaindb (+ contracts, addressdb...); find it by its database folder
SRC=$(find extract -type d -path "*/$CHAIN/blockchain*" | head -1)
[ -n "$SRC" ] || { echo "No $CHAIN/blockchain* folder found in the snapshot:"; find extract -maxdepth 4 -type d; exit 1; }
SRC_CHAIN=$(dirname "$SRC")
echo "snapshot chain folder: $SRC_CHAIN"
ls -la "$SRC_CHAIN"

echo "== Replacing chain data (wallet kept)"
mkdir -p "$DATA/$CHAIN"
for item in "$SRC_CHAIN"/*; do
  name=$(basename "$item")
  case "$name" in
    wallet*) echo "skipped $name (wallet)"; continue;;
  esac
  rm -rf "${DATA:?}/$CHAIN/$name"
  mv "$item" "$DATA/$CHAIN/$name"
  echo "loaded $name"
done

cd "$DATA" && rm -rf "$TMP"
echo "== Done. Start the node: docker compose up -d"
