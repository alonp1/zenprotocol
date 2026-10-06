#!/bin/bash
# Starts zen-node. MINER_THREADS>0 enables the CPU miner (needs a wallet - see Docker/README.md).
# EXTERNAL_IP lets other peers connect to this node.
# PUBLIC_NODE=1 public node for other users' wallets: no node wallet, address index, CORS (expose only via site/nginx-zen.conf).
# WALLET_API=1 serves the desktop Zen Wallet ("Mainnet | Local Node"): address index + CORS.
set -e
ARGS=(--data-path /data --api "*:11567")
[ "${MINER_THREADS:-0}" -gt 0 ] && ARGS+=(--miner "$MINER_THREADS")
[ -n "${EXTERNAL_IP:-}" ] && ARGS+=(--ip "$EXTERNAL_IP")
if [ "${PUBLIC_NODE:-0}" = "1" ]; then ARGS+=(--remote --origin any)
elif [ "${WALLET_API:-0}" = "1" ]; then ARGS+=(--addressdb --origin any); fi
exec mono /zen/zen-node.exe "${ARGS[@]}" "$@"
