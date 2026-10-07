#!/bin/bash
# Publish the newest snapshot on GitHub as a second download source (the first is this server's /snapshots).
# GitHub releases hold at most 2 GB per file, so the zip goes up in pieces; load-snapshot.sh joins and verifies them.
# Run on the server after creating a snapshot (docs/SETUP.md "Refreshing the snapshot"), logged in with `gh auth login`.
set -euo pipefail
REPO_SLUG="${REPO_SLUG:-alonp1/zenprotocol}"
SNAPDIR="${SNAPDIR:-$HOME/zenprotocol/zen-data/snapshots}"
TAG=snapshot-latest

LATEST=$(ls -1t "$SNAPDIR"/zen-node-*.zip 2>/dev/null | head -1)
[ -n "$LATEST" ] || { echo "no snapshot in $SNAPDIR"; exit 1; }
F=$(basename "$LATEST"); SHA=$(cut -d' ' -f1 "$LATEST.sha256"); BYTES=$(stat -c %s "$LATEST")
HEIGHT=$(echo "$F" | sed -E 's/zen-node-[0-9]+-([0-9]+)\.zip/\1/'); DATE=$(echo "$F" | sed -E 's/zen-node-([0-9]{4})([0-9]{2})([0-9]{2})-.*/\1-\2-\3/')
command -v gh >/dev/null || { echo "install the GitHub CLI: https://cli.github.com"; exit 1; }

W=$(mktemp -d "$SNAPDIR/.release.XXXX"); trap 'rm -rf "$W"' EXIT
split -b 1900M -d -a 2 "$LATEST" "$W/$F.part-"
PARTS=$(cd "$W" && ls "$F".part-* | sed 's/.*/"&"/' | paste -sd, -)
printf '{"file":"%s","height":%s,"date":"%s","sha256":"%s","bytes":%s,"parts":[%s]}\n' "$F" "$HEIGHT" "$DATE" "$SHA" "$BYTES" "$PARTS" > "$W/latest.json"

gh release view "$TAG" -R "$REPO_SLUG" >/dev/null 2>&1 || gh release create "$TAG" -R "$REPO_SLUG" --title "Latest chain snapshot" --notes "Chain data only, no wallets. Used by Docker/load-snapshot.sh (joins the parts and checks the sha256)."
# remove the previous pieces first, so the release never mixes two snapshots
for a in $(gh release view "$TAG" -R "$REPO_SLUG" --json assets -q '.assets[].name'); do gh release delete-asset "$TAG" "$a" -R "$REPO_SLUG" -y; done
gh release upload "$TAG" -R "$REPO_SLUG" "$W"/"$F".part-* "$W/latest.json"
echo "published $F (block $HEIGHT) as release $TAG"
