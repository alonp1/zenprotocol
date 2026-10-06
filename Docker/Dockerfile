# Zen Protocol node (+ optional CPU miner) - official release 1.0.13 (no version expiry)
#
# Stage 1: fetch the released binaries from the Zen npm registry
FROM node:20-bookworm-slim AS fetch
ARG ZEN_VERSION=1.0.13
RUN npm config set @zen:registry https://www.myget.org/F/zenprotocol/npm/ \
 && npm install -g --ignore-scripts "@zen/zen-node@${ZEN_VERSION}" \
 && cp -r "$(npm root -g)/@zen/zen-node/Release" /zen

# Stage 2: runtime on Mono 6.12
FROM mono:6.12
RUN sed -i 's|deb.debian.org/debian-security|archive.debian.org/debian-security|g; s|deb.debian.org/debian|archive.debian.org/debian|g; s|security.debian.org|archive.debian.org/debian-security|g' /etc/apt/sources.list \
 && sed -i '/buster-updates/d' /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends liblmdb0 libgomp1 curl unzip zip \
 && rm -rf /var/lib/apt/lists/*

COPY --from=fetch /zen /zen
COPY Docker/entrypoint.sh /entrypoint.sh
COPY Docker/load-snapshot.sh /load-snapshot.sh
COPY Docker/create-snapshot.sh /create-snapshot.sh
# strip Windows CRLF (git autocrlf on Windows checkouts) so bash can run the script
RUN sed -i "s/\r$//" /entrypoint.sh /load-snapshot.sh /create-snapshot.sh \
 && chmod +x /entrypoint.sh /load-snapshot.sh /create-snapshot.sh \
 && (chmod +x /zen/z3-linux 2>/dev/null || true) \
 && (grep -q "zen.sealinkgps.com" /zen/main.yaml || sed -i 's|^seeds:\s*$|seeds:\n  - zen.sealinkgps.com|' /zen/main.yaml) \
 && grep -q "zen.sealinkgps.com" /zen/main.yaml

WORKDIR /zen
VOLUME /data
EXPOSE 9655 11567

HEALTHCHECK --interval=2m --timeout=10s --start-period=10m \
  CMD curl -fs http://127.0.0.1:11567/blockchain/info >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
