#!/bin/bash
# Publishes the testnet pages (Dex, Oracle, Explorer, Assets) of this server over plain HTTP on its IP, next to the testnet stack
# (scripts/install-testnet-stack.sh). Read-only: the node's wallet and send endpoints are never exposed. Safe to run again.
# HTTPS and a domain come later (setup-site.sh does it for the community site): do not enter keys or passwords on this plain-HTTP page.
#
#   cd ~/zenprotocol-testnet && bash site/setup-testnet-web.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WEB=/var/www/zen-testnet
NODE=${NODE_PORT:-31567}; EXPLORER=${EXPLORER_PORT:-11581}; ORACLE=${ORACLE_PORT:-8085}; BRIDGE=${BRIDGE_PORT:-8090}
VOL=$(docker volume inspect "$(basename "$REPO")_stack-data" --format '{{.Mountpoint}}' 2>/dev/null || true)

command -v nginx >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx; }
mkdir -p "$WEB"
# the indexer writes its json files inside the docker volume (/var/lib/docker is closed to nginx): copy them out every minute
if [ -n "$VOL" ]; then
  cat > /etc/cron.d/zen-testnet-json <<CRON
* * * * * root for f in stats assets cgp-history community-votes; do [ -f "$VOL/web/\$f.json" ] && cp -f "$VOL/web/\$f.json" "$WEB/\$f.json"; done
CRON
  for f in stats assets cgp-history community-votes; do [ -f "$VOL/web/$f.json" ] && cp -f "$VOL/web/$f.json" "$WEB/$f.json"; done
fi
for f in dex oracle explorer assets stats cgp bridge guide instruments developers; do cp "$REPO/site/$f.html" "$WEB/$f.html"; done
cp "$REPO/site/testnet-home.html" "$WEB/index.html"
rm -rf "$WEB/shell"; cp -r "$REPO/site/shell" "$WEB/shell"
# Site frame settings. DOMAIN (e.g. testnet.example.org) turns on HTTPS; MAIN_URL links to the mainnet site.
old() { grep -o "\"$1\":\"[^\"]*\"" "$WEB/site-config.json" 2>/dev/null | cut -d'"' -f4 || true; }   # values from the last run are kept
DOMAIN="${DOMAIN:-}"; MAIN_URL="${MAIN_URL:-$(old mainUrl)}"; SITE_NAME="${SITE_NAME:-$(old name)}"; SITE_NAME="${SITE_NAME:-Zen Chain}"
printf '{"kind":"test","name":"%s","mainUrl":"%s","github":"https://github.com/alonp1/zenprotocol"}\n' "$SITE_NAME" "$MAIN_URL" > "$WEB/site-config.json"
# ZP Wallet on the same site: its node is this site's /node/ (config.json names it), so the testnet works at once. Plain HTTP: test coins only.
IP=$(curl -s -m 5 https://api.ipify.org || hostname -I | awk '{print $1}')
BASE=${DOMAIN:+https://$DOMAIN}; BASE=${BASE:-http://$IP}
if command -v docker >/dev/null; then
  docker run --rm -v "$REPO:/r" -w /r/wallet node:22-alpine sh -c "npm ci --no-audit --no-fund && npm test && npm run build" \
    && { rm -rf "$WEB/wallet"; mkdir -p "$WEB/wallet"; cp "$REPO"/wallet/dist/* "$WEB/wallet/"; echo "{\"testNode\":\"$BASE/node\"}" > "$WEB/wallet/config.json"; echo "wallet published at /wallet/"; } \
    || echo "wallet build or tests failed: /wallet/ left as it was"
fi

cat > /etc/nginx/sites-available/zen-testnet <<CONF
limit_req_zone \$binary_remote_addr zone=zentest:10m rate=10r/s;
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${DOMAIN:-_};
    root $WEB;
    index index.html;

    location = /api/info  { limit_except GET { deny all; } proxy_pass http://127.0.0.1:$NODE/blockchain/info; add_header Cache-Control "no-store"; }
    location = /api/peers { limit_except GET { deny all; } proxy_pass http://127.0.0.1:$NODE/network/connections/count; add_header Cache-Control "no-store"; }

    # read-only node endpoints for the explorer and light wallets
    location ~ ^/node/(blockchain/(info|headers|cgp|mempool|block|blocks|transaction|winner|totalzp|candidates|blockreward|publishtransaction|contract/execute)|addressdb/(balance|outputs|transactions|transactioncount|discovery)|contract/active|address/decode)\$ {
        limit_req zone=zentest burst=40 nodelay;
        proxy_pass http://127.0.0.1:$NODE/\$1\$is_args\$args;
        add_header Cache-Control "no-store";
    }
    location /node/ { return 404; }

    location /explorer/api/ { limit_req zone=zentest burst=40 nodelay; proxy_pass http://127.0.0.1:$EXPLORER; proxy_read_timeout 90s; add_header Cache-Control "no-cache"; }
    location ~ ^/oracle/(health|rounds|rounds/latest|auditpath)\$ {
        limit_req zone=zentest burst=20 nodelay; limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:$ORACLE/\$1\$is_args\$args;
        add_header Cache-Control "no-cache"; add_header Access-Control-Allow-Origin "*";
    }
    location = /bridge/status { limit_except GET { deny all; } proxy_pass http://127.0.0.1:$BRIDGE/status; add_header Cache-Control "no-cache"; }

    # files the indexer writes (assets, ...)
    location ~ ^/(stats|assets|cgp-history|community-votes)\.json\$ { root $WEB; add_header Cache-Control "no-cache"; }
    location / { try_files \$uri \$uri/ =404; }
}
CONF
ln -sf /etc/nginx/sites-available/zen-testnet /etc/nginx/sites-enabled/zen-testnet
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx || systemctl restart nginx
IP=$(curl -s -m 5 https://api.ipify.org || hostname -I | awk '{print $1}')
if [ -n "$DOMAIN" ]; then
  command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect --keep-until-expiring
  echo "Published: https://$DOMAIN/"
else
  echo "Published: http://$IP/   (Dex: http://$IP/dex.html)"
fi
