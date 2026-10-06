#!/bin/bash
# Publish the community node page + snapshots on this server (nginx + Let's Encrypt).
# Safe next to other nginx sites (e.g. Traccar): adds its own server block only.
#
# Usage (from the zenprotocol folder, as root):
#   bash site/setup-site.sh            # install/update site, publish newest snapshot
set -euo pipefail

DOMAIN="${DOMAIN:-zen.sealinkgps.com}"
WEB=/var/www/zen
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SNAPDIR="$REPO/zen-data/snapshots"

echo "== Checks"
command -v nginx >/dev/null || { echo "nginx not installed"; exit 1; }
IP=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
echo "$DOMAIN -> ${IP:-<no DNS yet>}"

echo "== Files"
mkdir -p "$WEB/snapshots"
cp "$REPO/site/index.html" "$WEB/index.html"
cp "$REPO/site/stats.html" "$WEB/stats.html"

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
cp "$REPO/site/nginx-zen.conf" "/etc/nginx/sites-available/$DOMAIN"
sed -i "s/zen.sealinkgps.com/$DOMAIN/g" "/etc/nginx/sites-available/$DOMAIN"
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
Description=Refresh ZP network stats every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now zen-stats.timer
systemctl start zen-stats.service || echo "stats not built yet (node busy or syncing) - the timer retries every 5 minutes"

echo "== HTTPS"
if ! command -v certbot >/dev/null; then apt-get install -y certbot python3-certbot-nginx; fi
# Always run: copying nginx-zen.conf above replaces the HTTPS block certbot added last time.
# With an existing certificate this only re-installs it (no new issuance).
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email \
  --redirect --keep-until-expiring

echo "== Check"
curl -fsS "https://$DOMAIN/api/info" && echo
curl -s -o /dev/null -w "wallet API blocked: HTTP %{http_code}\n" "https://$DOMAIN/api/wallet/balance"
echo "== Done: https://$DOMAIN"
