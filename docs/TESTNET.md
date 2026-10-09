# ZP testnet and private test networks

Everything here is for testing. Testnet coins have no value. Mainnet is not touched by any of it: the testnet has its own network id and genesis block, and the mainnet replay check (`scripts/check-against-reference.sh`) still passes.

| | Testnet (public, ours) | Devnet (private, local chain) |
|---|---|---|
| Use | Wallets, explorers, upgrades, load tests on the release build | Quick experiments on your own machine, 1-minute blocks, trivial difficulty |
| Build | Release (the normal node image) | Debug only (the `local` chain exists only in Debug builds) |
| Genesis | In the code: `Chain.testGenesisHex` | In the code (Debug builds) |
| Network id | 2026 | 1002 |
| Address prefix | `tzn` | `tzn` |
| P2P / API port | 29555 / 31567 | inside the container: 10000+n / 20000+n |
| Start | `docker compose -f docker-compose.testnet.yml up -d` | `scripts/devnet.sh up` |

## Why our own testnet

The original testnet (network id 2016) lived on the developers' servers. Its genesis block was never part of the code (only its hash), so a node could not start it without those servers. Our testnet carries its genesis block in the code. A node needs no server to start it, and anyone can start a testnet node, or a whole private copy, from this repository alone.

## Parameters

Defined in `src/Consensus/Chain.fs` (`testParameters`):

| Parameter | Value |
|---|---|
| Network id | 2026 |
| Genesis block hash | `211b6deb68ff0d91e99aeeb5519a5c817bb2182741b34788013c44e2bcc0c0b7` |
| Genesis time | 2026-10-07 00:00:00 UTC |
| Proof-of-work limit (starting difficulty) | `0x1dffffff` (about 16 million hashes for the first blocks; difficulty then follows the hash rate) |
| Block interval target | 236.682 s (same as mainnet) |
| Coinbase maturity | 10 blocks |
| CGP interval | 100 blocks (10,000 on mainnet) |
| Seeds | `testnetSeeds` in `network.json`, read at every start |

The CGP and voting contracts are activated by `scripts/testnet-cgp-contracts.sh`, and a whole CGP cycle (allocation vote, nominations, payout vote, payout) has been run on the testnet.

**The CGP payout transaction.** In the block that pays the winner (block number % interval = coinbase maturity: the 10th block of an interval on the testnet, the 100th on mainnet) the block must contain a transaction that executes the CGP contract (`Payout`). Only a real winner needs it (the default nominee does not). Older nodes did not create it: the block template logged `You should create your own contract execution`, and every mined block was rejected with `No payout Tx` until someone sent it, so the chain waited (this happened on the testnet at block 410). A miner change that built the transaction itself (2026-10-09) was tried on the testnet at block 610 and **reverted**: with it, every mined block 610 was rejected with `commitments mismatch` (5 attempts, those blocks held 3 or 4 transactions); after a restart and the hand-made transaction below, block 610 was accepted (2 transactions). The cause is not yet known (it may be the miner-made transaction, or any block with extra transactions in a payout block), so the node does not create it. Send it by hand with `bash scripts/cgp-payout.sh` (calls `POST /wallet/contract/cgp`) shortly before the payout block.

**How the testnet CGP vote was tested.** A full cycle ran on testnet id 2026 (interval 100): allocation votes (10% decided), 4 nominations, payout votes, winner paid 2 ZP at block 410. Tools: `wallet/tools/cgp-sim.sh` (scripted voters), `wallet/tools/cgp-vote.sh` (one vote from the command line), `wallet/tools/cgp-check.sh` (read-only readiness check, also for `--net main`), and the wallet Vote screen tested in Chromium against a mock node (`wallet/tools/ui-test`). The `/cgp.html` page shows the range, the split in force, the winner and the payout block live from the node.

## Run a testnet node

```bash
docker compose -f docker-compose.testnet.yml up -d          # a node that follows the testnet
MINER_THREADS=1 docker compose -f docker-compose.testnet.yml up -d    # and mines (CPU)
curl -s http://127.0.0.1:31567/blockchain/info               # "chain":"testnet"
```

The node image is the normal .NET 10 release image; `NETWORK=test` selects the testnet (`Docker/entrypoint.sh`). Environment variables: `MINER_THREADS`, `EXTERNAL_IP`, `SEEDS` (comma separated host names or `ip:port`; a host name without a port uses the node port, 29555), `TESTNET_MNEMONIC` (gives the node's wallet a known 24-word phrase, for tests only).

The address index is on (`WALLET_API=1`), so wallets and the load generator can read balances. The ZP Wallet in `wallet/` talks to it as a testnet node (addresses start with `tzn`, wallets of the two networks are kept apart).

## Your own private testnet (3 nodes, mining, in about a minute)

This is exactly what the CI job `testnet` does. Needs only Docker:

```bash
docker build -f Docker/Dockerfile.net10 -t zen-testnet .
docker network create zt
MN="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
docker run -d --name zt-a --network zt -p 127.0.0.1:31567:31567 -e NETWORK=test -e NETWORK_URL=off \
  -e MINER_THREADS=2 -e WALLET_API=1 -e TESTNET_MNEMONIC="$MN" zen-testnet
sleep 40
for n in b c; do docker run -d --name zt-$n --network zt -e NETWORK=test -e SEEDS=zt-a -e WALLET_API=1 zen-testnet; done
```

That network has the same genesis as the public testnet, so to keep it separate from the public one leave `NETWORK_URL=off` and give every node `SEEDS`, so none of them contacts the public seeds. (A fully different chain, with its own genesis and parameters, is made with `scripts/devnet/make-genesis.mjs` and a change in `Chain.fs`; a configuration-file version of that is planned.)

The mnemonic above is public and worthless: anyone can spend those coins. That is the point, because the load generator and tests need to sign with it.

## Devnet: private network on the `local` chain

```bash
scripts/devnet.sh up        # builds the Debug image, starts 3 nodes with a miner, waits for the first blocks
scripts/devnet.sh status    # heights of the three nodes (ports 20000-20002)
scripts/devnet.sh load      # signed transactions at 5, 20, 50 per second, prints a table
scripts/devnet.sh down      # or: reset (also deletes the chain)
```

Blocks come about every minute (60 s target) and the difficulty is trivial, so a few hundred blocks take minutes. The Debug build is slower than Release; use the testnet above for numbers.

## Load test

`scripts/devnet/loadgen.mjs` uses the wallet library to sign real transactions (1 input, 1 payment, 1 change) and posts them to `/blockchain/publishtransaction` at a fixed rate, stepping up through the rates you give. For each step it reports: accepted per second, publish latency (p50, p95), rejected count and reasons, transactions confirmed and per block, how long the mempool took to drain, and how far the nodes' heights differ (lag).

```bash
node scripts/devnet/loadgen.mjs --node http://127.0.0.1:31567 --nodes 31567,31568,31569 --rates 50,100,200 --seconds 30
```

It first splits mined coinbase outputs into thousands of small outputs (so many transactions can be signed in parallel), then runs the steps. GitHub: Actions > `testnet` > Run workflow, with your own rates (the result is shown as a notice on the run and uploaded as `testnet-result`).

### Results

First run on the Release build (shared 4-vCPU runner, 3 nodes, one miner and the generator together, 10 s per step):

| Offered | Accepted/s | Latency p50 / p95 | Rejected | Largest block | Lag |
|---|---|---|---|---|---|
| 50/s | 34.4 | 0.5 / 2.8 s | 0 | 443 txs | 0 |
| 100/s | 25.0 | 2.3 / 4.5 s | 0 | 673 txs | 0 |
| 200/s | 16.6 | 3.6 / 5.8 s | 0 | 1,096 txs | 0 |
| 500/s | 7.2 | 7.8 / 18.0 s | 0 | 4,868 txs | 0 |

Nothing was lost or rejected and the nodes never fell behind, but intake fell as the mempool backlog grew (the steps run back to back). Details, reading and caveats: the Capacity section of [MIGRATION.md](MIGRATION.md#capacity-and-load-test).

## Checks that run on every change

| Workflow | What it proves |
|---|---|
| `testnet` | The release image starts the testnet from the genesis block in the code, the miner mines, two other nodes find the first one and reach the same height, and the load generator gets its transactions accepted and confirmed with zero lag |
| `devnet` | The same on the Debug image and the `local` chain, 3 nodes and rates up to 100 per second |
| `net10` | Unit tests, node starts and syncs mainnet blocks |
| mainnet replay (`net10-replay`) | The whole mainnet chain, 1,053 block hashes and the CGP state, still match the reference |

## Contracts and instruments on the testnet

Contracts can be activated and executed on the testnet with the node API (`/wallet/contract/activate`, `/wallet/contract/execute`). The CI workflow `testnet` does it for a token, a named token, an issuer-controlled token, the oracle, a decentralised exchange and a bet. See [INSTRUMENTS.md](INSTRUMENTS.md) and [ORACLE.md](ORACLE.md).

## Proposing a change and testing it

1. Fork the repository and change the code (consensus rules for the testnet only go in `Chain.fs` parameters and the files they use).
2. Open a pull request. CI builds the release image, starts the three-node testnet and runs the load generator.
3. Your own run on a server of your own: the commands above, with your image (`docker build ... -t your-image`, `ZEN_TESTNET_IMAGE=your-image`).
4. Any change that touches how blocks or transactions are read, written or validated must also pass the mainnet replay (see MIGRATION.md, "Consensus safety rules").

## Moving or adding a seed

Edit `testnetSeeds` in `network.json`; every node reads it at start. A seed is a node that stays online with its P2P port (29555) open: `EXTERNAL_IP=<public ip> docker compose -f docker-compose.testnet.yml up -d`. On a fresh server one command does it all (Docker, firewall, image, start): `curl -fsSL https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/scripts/install-testnet-seed.sh | bash`; give a second seed the first one with `SEEDS=<first seed>`. The first public seed is `91.98.3.17` (port 29555); it moves to a host name when the new domain is ready.

## Plan

1. Public seed node for the testnet on the server, plus a faucet and explorer view for it.
2. Activate the CGP and voting contracts in a testnet genesis, so the CGP voting screens can be tested.
3. Chain parameters from a configuration file (`--chain-file`), for private networks with their own genesis, block time and CGP interval, without recompiling. Never accepted for mainnet.
4. Scenario tests in CI: fork and reorg, CGP vote, contract activation, old node against new node on the same chain.
