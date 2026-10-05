#!/bin/bash
# Starts zen-node. MINER_THREADS>0 enables the CPU miner (needs a wallet - see Docker/README.md).
# EXTERNAL_IP lets other peers connect to this node.
set -e
ARGS=(--data-path /data --api "0.0.0.0:11567")
[ "${MINER_THREADS:-0}" -gt 0 ] && ARGS+=(--miner "$MINER_THREADS")
[ -n "${EXTERNAL_IP:-}" ] && ARGS+=(--ip "$EXTERNAL_IP")
exec mono /zen/zen-node.exe "${ARGS[@]}" "$@"
