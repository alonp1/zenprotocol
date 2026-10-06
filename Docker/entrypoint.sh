#!/bin/bash
# Starts zen-node. MINER_THREADS>0 enables the CPU miner (needs a wallet - see Docker/README.md).
# EXTERNAL_IP lets other peers connect to this node.
# WALLET_API=1 serves the desktop Zen Wallet ("Mainnet | Local Node"): address index + CORS.
set -e
ARGS=(--data-path /data --api "*:11567")
[ "${MINER_THREADS:-0}" -gt 0 ] && ARGS+=(--miner "$MINER_THREADS")
[ -n "${EXTERNAL_IP:-}" ] && ARGS+=(--ip "$EXTERNAL_IP")
[ "${WALLET_API:-0}" = "1" ] && ARGS+=(--addressdb --origin any)
exec mono /zen/zen-node.exe "${ARGS[@]}" "$@"
