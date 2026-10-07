#!/bin/bash
# Download our copy of the MyGet packages (release upstream-mirror) into ./packages-mirror, for building the node
# from source when the original MyGet feed is gone. Then restore with:
#   dotnet restore src/Node/Node.fsproj --source ./packages-mirror --source https://api.nuget.org/v3/index.json
set -euo pipefail
BASE="${MIRROR:-https://github.com/alonp1/zenprotocol/releases/download/upstream-mirror}"
mkdir -p packages-mirror && cd packages-mirror
curl -fsSL "$BASE/MANIFEST.json" -o MANIFEST.json
# only the packages the build pins (paket.lock, myget section) - not the CI builds in the feed
for f in $(sed -n '/remote: https:\/\/www.myget.org/,/^[A-Z]/p' ../paket.lock | sed -n 's/^    \([A-Za-z0-9_.-]*\) (\([^)]*\)).*/\1.\2.nupkg/p'); do
  [ -f "$f" ] || curl -fL -sS -o "$f" "$BASE/packages__$f"
  want=$(grep -A2 "\"packages/$f\"" MANIFEST.json | sed -n 's/.*"sha256": "\([0-9a-f]*\)".*/\1/p')
  [ -z "$want" ] || echo "$want  $f" | sha256sum -c --quiet || { echo "checksum mismatch: $f"; exit 1; }
  echo "ok $f"
done
