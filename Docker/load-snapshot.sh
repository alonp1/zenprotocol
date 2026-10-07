#!/bin/bash
# Load a blockchain snapshot into /data so the node skips most of the initial sync. The wallet is never touched.
#
# Where the snapshot comes from (first that works wins, always checked against its sha256):
#   1. SNAPSHOT_URL  - a URL of a .zip, or a file path inside the container (e.g. /data/snapshots/<file>.zip)
#   2. every base address in network.json "snapshotSources" (read from the repository, so a moved server
#      only needs that file edited). Each base publishes latest.json: {file, sha256, bytes, parts?}.
#      "parts" lists pieces of one big file (GitHub releases hold at most 2 GB per file); they are joined.
#   3. the official Feb-2023 snapshot (last resort, old: the node syncs the rest)
# Run with the node STOPPED, from the zenprotocol folder:
#   docker compose down
#   docker compose run --rm --no-deps --entrypoint /load-snapshot.sh zen-node
#   docker compose up -d
set -euo pipefail

NETWORK_URL="${NETWORK_URL:-https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/network.json}"
FALLBACK="https://node-backups.s3-eu-west-1.amazonaws.com/zen-node.zip"
# used when network.json cannot be fetched
DEFAULT_SOURCES="https://zen.sealinkgps.com/snapshots https://github.com/alonp1/zenprotocol/releases/download/snapshot-latest"
DATA=/data
TMP="$DATA/.snapshot-tmp"
CHAIN="${CHAIN:-main}"

mkdir -p "$TMP"
cd "$TMP"
# no progress bar when the output is not a terminal (it fills logs with one huge line)
Q=""; [ -t 1 ] || Q="-sS"

# json_get <file> <key>: first value of "key": "..." / ["a","b"] ... (no jq in the image)
sources() {
  local list
  list=$(curl -fsSL -m 30 "$NETWORK_URL" 2>/dev/null | tr -d '\n' | sed -n 's/.*"snapshotSources" *: *\[\([^]]*\)\].*/\1/p' | grep -o 'https\?://[^"]*' || true)
  [ -n "$list" ] && echo "$list" || tr ' ' '\n' <<<"$DEFAULT_SOURCES"
}
field() { sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p" "$2" | head -1; }
parts() { sed -n 's/.*"parts" *: *\[\([^]]*\)\].*/\1/p' "$1" | grep -o '"[^"]*"' | tr -d '"'; }

fetch_from() {   # <base>: leaves zen-node.zip verified, returns 1 otherwise
  local base="$1" f sha
  echo "== Trying $base"
  curl -fsSL -m 30 -o latest.json "$base/latest.json" || { echo "   no latest.json"; return 1; }
  f=$(field file latest.json); sha=$(field sha256 latest.json)
  [ -n "$f" ] && [ -n "$sha" ] || { echo "   latest.json incomplete"; return 1; }
  rm -f zen-node.zip
  if [ -n "$(parts latest.json)" ]; then
    for p in $(parts latest.json); do curl -fL $Q -C - -o "$p" "$base/$p" || return 1; done
    cat $(parts latest.json) > zen-node.zip && rm -f $(parts latest.json)
  else
    curl -fL $Q -C - -o zen-node.zip "$base/$f" || return 1
  fi
  echo "$sha  zen-node.zip" | sha256sum -c --status || { echo "   checksum mismatch - discarded"; rm -f zen-node.zip; return 1; }
  echo "   checksum ok ($f)"
}

echo "== Getting the snapshot (resumable)"
got=0
if [ -n "${SNAPSHOT_URL:-}" ]; then
  if [ -f "$SNAPSHOT_URL" ]; then ln -f "$SNAPSHOT_URL" zen-node.zip 2>/dev/null || cp "$SNAPSHOT_URL" zen-node.zip; got=1
  elif curl -fL $Q -C - -o zen-node.zip "$SNAPSHOT_URL"; then got=1; fi
fi
if [ "$got" = 0 ]; then
  for base in $(sources); do fetch_from "$base" && { got=1; break; }; done
fi
if [ "$got" = 0 ]; then
  echo "No community snapshot reachable, using the official Feb-2023 snapshot (the node syncs the rest)"
  rm -f zen-node.zip; curl -fL $Q -o zen-node.zip "$FALLBACK"
fi

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
