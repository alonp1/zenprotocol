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
cp "$REPO"/site/{index,dex,oracle,explorer,assets,stats,cgp}.html "$WEB/"
cat > "$WEB/index.html" <<HTML
<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZP testnet</title>
<style>body{font:16px system-ui;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.6}a{display:block;padding:12px 0;font-size:18px}small{color:#666}</style>
<h1>Zen Protocol testnet</h1><small>Plain HTTP, test coins only. Do not enter real keys or passwords here.</small>
<a href="/dex.html">Dex: order book and trades</a><a href="/oracle.html">Oracle: published prices</a>
<a href="/explorer.html">Explorer</a><a href="/assets.html">Assets</a><a href="/bridge/status">Bridge status (mock)</a>
HTML

cat > /etc/nginx/sites-available/zen-testnet <<CONF
limit_req_zone \$binary_remote_addr zone=zentest:10m rate=10r/s;
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root $WEB;
    index index.html;

    location = /api/info  { limit_except GET { deny all; } proxy_pass http://127.0.0.1:$NODE/blockchain/info; add_header Cache-Control "no-store"; }
    location = /api/peers { limit_except GET { deny all; } proxy_pass http://127.0.0.1:$NODE/network/connections/count; add_header Cache-Control "no-store"; }

    # read-only node endpoints for the explorer and light wallets
    location ~ ^/node/(blockchain/(info|headers|cgp|mempool|block|blocks|transaction|winner|totalzp|candidates|blockreward)|addressdb/(balance|outputs|transactions|transactioncount|discovery)|contract/active|address/decode)\$ {
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
    location ~ ^/(stats|assets|cgp-history)\.json\$ { root ${VOL:-$WEB}/web; add_header Cache-Control "no-cache"; }
    location / { try_files \$uri \$uri/ =404; }
}
CONF
ln -sf /etc/nginx/sites-available/zen-testnet /etc/nginx/sites-enabled/zen-testnet
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx || systemctl restart nginx
IP=$(curl -s -m 5 https://api.ipify.org || hostname -I | awk '{print $1}')
echo "Published: http://$IP/   (Dex: http://$IP/dex.html)"
