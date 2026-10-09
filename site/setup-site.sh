#!/bin/bash
# Publish the community node page + snapshots on this server (nginx + Let's Encrypt).
# Safe next to other nginx sites (e.g. Traccar): adds its own server block only.
#
# Usage (from the zenprotocol folder, as root):
#   bash site/setup-site.sh            # install/update site, publish newest snapshot
set -euo pipefail

DOMAIN="${DOMAIN:-zen.sealinkgps.com}"
# Other names served by the same site, e.g. the old domain while moving: EXTRA_DOMAINS="zen.sealinkgps.com"
EXTRA_DOMAINS="${EXTRA_DOMAINS:-}"
WEB=/var/www/zen
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SNAPDIR="$REPO/zen-data/snapshots"

echo "== Checks"
command -v nginx >/dev/null || { echo "nginx not installed"; exit 1; }
IP=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
echo "$DOMAIN -> ${IP:-<no DNS yet>}"

echo "== Files"
mkdir -p "$WEB/snapshots"
for f in index about how-it-works community node mine developers stats assets cgp votes explorer contract; do cp "$REPO/site/$f.html" "$WEB/$f.html"; done
rm -rf "$WEB/shell"; cp -r "$REPO/site/shell" "$WEB/shell"
# Site frame settings (menus, name, link to the other network). Set SITE_NAME / TEST_URL once; they are kept in the file for later runs.
old() { grep -o "\"$1\":\"[^\"]*\"" "$WEB/site-config.json" 2>/dev/null | cut -d'"' -f4 || true; }   # values from the last run are kept
SITE_NAME="${SITE_NAME:-$(old name)}"; SITE_NAME="${SITE_NAME:-Zen Chain}"; TEST_URL="${TEST_URL:-$(old testUrl)}"
printf '{"kind":"main","name":"%s","testUrl":"%s","github":"https://github.com/alonp1/zenprotocol"}\n' "$SITE_NAME" "$TEST_URL" > "$WEB/site-config.json"

echo "== ZP Wallet (built in a throwaway node container: nothing to install on the server)"
if command -v docker >/dev/null; then
  docker run --rm -v "$REPO:/r" -w /r/wallet node:22-alpine sh -c "npm ci --no-audit --no-fund && npm test && npm run build" \
    && { rm -rf "$WEB/wallet"; mkdir -p "$WEB/wallet"; cp "$REPO"/wallet/dist/* "$WEB/wallet/"; echo "wallet published at /wallet/"; } \
    || echo "wallet build or tests failed: /wallet/ left as it was"
else
  echo "docker not found: skipping the wallet"
fi

echo "== Publish newest snapshot (hard link, no extra disk)"
LATEST=$(ls -1t "$SNAPDIR"/zen-node-*.zip 2>/dev/null | head -1 || true)
if [ -n "$LATEST" ]; then
  F=$(basename "$LATEST")
  # remove older published snapshots, link the newest
  find "$WEB/snapshots" -name 'zen-node-*.zip*' ! -name "$F*" -delete
  ln -f "$LATEST" "$WEB/snapshots/$F" 2>/dev/null || cp "$LATEST" "$WEB/snapshots/$F"
  cp "$LATEST.sha256" "$WEB/snapshots/$F.sha256"
  HEIGHT=$(echo "$F" | sed -E 's/zen-node-[0-9]+-([0-9]+)\.zip/\1/')
  DATE=$(echo "$F" | sed -E 's/zen-node-([0-9]{4})([0-9]{2})([0-9]{2})-.*/\1-\2-\3/')
  SHA=$(cut -d' ' -f1 "$LATEST.sha256")
  BYTES=$(stat -c %s "$LATEST")
  printf '{"file":"%s","height":%s,"date":"%s","sha256":"%s","bytes":%s}\n' \
    "$F" "$HEIGHT" "$DATE" "$SHA" "$BYTES" > "$WEB/snapshots/latest.json"
  ln -sf "$F" "$WEB/snapshots/latest.zip"
  echo "published $F"
else
  echo "no snapshot in $SNAPDIR (skipping)"
fi
chmod -R a+rX "$WEB"

echo "== nginx"
# a site installed earlier under another domain name would clash with this one: disable it
for f in /etc/nginx/sites-enabled/*; do
  [ "$(basename "$f")" != "$DOMAIN" ] && grep -q "Community node page" "$f" 2>/dev/null && { echo "disabling old site $f"; rm -f "$f"; }
done
cp "$REPO/site/nginx-zen.conf" "/etc/nginx/sites-available/$DOMAIN"
sed -i "s/server_name zen.sealinkgps.com;/server_name $DOMAIN $EXTRA_DOMAINS;/" "/etc/nginx/sites-available/$DOMAIN"
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
nginx -t
systemctl reload nginx

echo "== Stats (stats.json every 5 minutes)"
cat > /etc/systemd/system/zen-stats.service <<UNIT
[Unit]
Description=Build ZP network stats.json for the public stats page
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 $REPO/site/update-stats.py --out $WEB/stats.json
UNIT
cat > /etc/systemd/system/zen-stats.timer <<UNIT
[Unit]
Description=Refresh ZP network stats every 15 minutes (each run asks the node for about 2 minutes of work)
[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now zen-stats.timer
systemctl start zen-stats.service || echo "stats not built yet (node busy or syncing) - the timer retries every 5 minutes"

mkdir -p /var/lib/zen-stats
echo "== Chain index (assets.json, cgp-history.json; first run indexes from genesis in 5-minute steps)"
cat > /etc/systemd/system/zen-index.service <<UNIT
[Unit]
Description=Index the ZP chain for the assets and CGP history pages
[Service]
Type=oneshot
TimeoutStartSec=20min
# Node 22 in a throwaway container (built-in SQLite; the wallet's block decoder, installed by the wallet build above)
ExecStart=/usr/bin/docker run --rm --name zen-index --network host -v $REPO:/r:ro -v /var/lib/zen-stats:/var/lib/zen-stats -v $WEB:$WEB node:22-alpine node --no-warnings --experimental-sqlite /r/site/chain-index.mjs --web $WEB --budget 270
UNIT
cat > /etc/systemd/system/zen-index.timer <<UNIT
[Unit]
Description=Update the ZP chain index every 5 minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now zen-index.timer
systemctl start --no-block zen-index.service

echo "== Explorer API (read-only, 127.0.0.1:11580, published by nginx as /explorer/api/)"
cat > /etc/systemd/system/zen-explorer.service <<UNIT
[Unit]
Description=ZP explorer API over the chain index
After=docker.service
Requires=docker.service
[Service]
ExecStartPre=-/usr/bin/docker rm -f zen-explorer
ExecStart=/usr/bin/docker run --rm --name zen-explorer --network host -v $REPO:/r:ro -v /var/lib/zen-stats:/var/lib/zen-stats node:22-alpine node --no-warnings --experimental-sqlite /r/site/explorer-api.mjs
ExecStop=/usr/bin/docker stop zen-explorer
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable zen-explorer.service
systemctl restart zen-explorer.service

echo "== HTTPS"
if ! command -v certbot >/dev/null; then apt-get install -y certbot python3-certbot-nginx; fi
# Always run: copying nginx-zen.conf above replaces the HTTPS block certbot added last time.
# With an existing certificate this only re-installs it (no new issuance).
certbot --nginx -d "$DOMAIN" $(for d in $EXTRA_DOMAINS; do echo -n " -d $d"; done) --non-interactive --agree-tos --register-unsafely-without-email \
  --redirect --keep-until-expiring

echo "== Check"
curl -fsS "https://$DOMAIN/api/info" && echo
curl -s -o /dev/null -w "ZP Wallet: HTTP %{http_code}\n" "https://$DOMAIN/wallet/"
sleep 5; curl -s -o /dev/null -w "Explorer API: HTTP %{http_code}\n" "https://$DOMAIN/explorer/api/blocks?take=1"
curl -s -o /dev/null -w "wallet API blocked: HTTP %{http_code}\n" "https://$DOMAIN/api/wallet/balance"
echo "== Done: https://$DOMAIN"
