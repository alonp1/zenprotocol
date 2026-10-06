# ZP GPU miner

OpenCL miner for the ZP proof of work (SHA3-256 of the 100-byte block header). Runs on NVIDIA, AMD and Intel GPUs on Windows and Linux, and mines through a local zen-node.

## Install

Python 3.9+ and the normal GPU driver (it includes OpenCL), then:

```
pip install pyopencl numpy
```

## Check, then measure

```
python zpminer.py list          # OpenCL devices
python zpminer.py selftest      # GPU hashes == Python hashlib SHA3-256
python zpminer.py bench         # hashrate (no node needed)
python zpminer.py verify        # rebuilds real mainnet headers from the local node and checks their hashes
```

Run `verify` once against a synced node before mining.

## Mine

A synced node must run on the same machine (Docker setup in `../Docker`, API on `127.0.0.1:11567`). The node's built-in CPU miner is not needed (`MINER_THREADS=0`).

```
python zpminer.py mine --address zen1...your-address
```

Rewards go to `--address` (any address you own; no wallet on the node is needed). Use `--device N` to pick a GPU; run one process per GPU. Each process picks a random `nonce1`, so workers never overlap.

## How it works

- `GET /blockchain/blocktemplate?address=` returns the header to mine and the target. The miner refreshes it every 5 seconds.
- The kernel (`zp_sha3.cl`) absorbs the header in one SHA3 block, varies the last 8 bytes (`nonce2`) per work item and reports nonces whose first 64 bits are at or below the target. The host re-checks the full 256-bit hash with Python's `hashlib`.
- A valid header goes to `POST /blockchain/submitheader`.

Block rewards are coinbase outputs, spendable after 100 blocks.
