# ZP – Running a Node and a Miner

Updated: 2026-10-07

## Overview

A node validates and relays the blockchain. A miner is a node that also mines blocks and earns 25 ZP per block. Run nodes on cloud servers, but mine only on hardware you own: most cloud providers forbid mining.

| Machine | Role | Method | Mining |
| --- | --- | --- | --- |
| Linux server (Ubuntu) | Public node for wallets, seed, status page, snapshots | Docker + Nginx | Not allowed |
| Home computer (Windows/macOS/Linux) | Node + miner | Docker Desktop | Allowed |

All installs use the official 1.0.13 release, the first without a version expiry date. A new node loads a recent snapshot and is in sync within minutes.

### Public node for wallets (dedicated server)

The community public node serves light wallets (ZP Wallet) through `https://<domain>/node/`. It runs on its own server so it cannot disturb other services; since 2026-10-07 that is a Hetzner CX33 (4 vCPU, 8 GB RAM, 80 GB disk, Ubuntu 24.04). Load: ~10 GB chain + address index, 4.8 GB published snapshot, ~5 GB temporary during a monthly snapshot.

Light wallets need a node with an address index (AddressDB). Release 1.0.13 cannot build it from scratch on today's chain, so it comes inside the published snapshot (see *Rebuilding the address index snapshot* below); the node then keeps it up to date block by block.

**Fresh server, step by step** (firewall: allow TCP 22, 80, 443, 9655):

```
curl -fsSL https://get.docker.com | sh
apt-get install -y nginx
git clone -b node-upgrade-script https://github.com/alonp1/zenprotocol.git && cd zenprotocol
F=$(curl -s https://zen.sealinkgps.com/snapshots/latest.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["file"])')
mkdir -p zen-data/snapshots
curl -o zen-data/snapshots/$F https://zen.sealinkgps.com/snapshots/$F
curl -o zen-data/snapshots/$F.sha256 https://zen.sealinkgps.com/snapshots/$F.sha256
(cd zen-data/snapshots && sha256sum -c $F.sha256)
printf "EXTERNAL_IP=%s\nPUBLIC_NODE=1\nMINER_THREADS=0\nZEN_CPUS=3.0\nZEN_MEM=5g\n" "$(curl -4 -s ifconfig.me)" > .env
docker compose build                  # build first: the loader that reads a local file is in the new image
docker compose run --rm --no-deps -e SNAPSHOT_URL=/data/snapshots/$F --entrypoint /load-snapshot.sh zen-node
docker compose up -d
docker compose logs --tail 8          # must show "AddressDB adding block", never "Creating AddressDB"
```

The loader must print `loaded addressdb` and `loaded blockchaindb`. Then point the domain's DNS A record at the server (Cloudflare: DNS only), wait until `getent hosts <domain>` returns the new IP, and run:

```
bash site/setup-site.sh               # nginx site, /node/ proxy, ZP Wallet at /wallet/, stats timer, snapshot publishing, HTTPS
```

`setup-site.sh` also builds and tests ZP Wallet in a temporary Node.js container and publishes it at `/wallet/` with strict security headers. Details: [`WALLET.md`](WALLET.md).

**Moving the public node to another server**: set up the new server as above (it downloads the snapshot from the current one), switch DNS, run `setup-site.sh` there, then on the old server: `docker compose down`, `rm /etc/nginx/sites-enabled/<domain> && systemctl reload nginx`, `systemctl disable --now zen-stats.timer`, and after a day `rm -rf ~/zenprotocol/zen-data`.

`PUBLIC_NODE=1` runs the node with `--remote`: no node wallet, address index on, CORS open. Never set it on a mining node.

### Rebuilding the address index snapshot

Only needed if no published snapshot contains the index any more. It needs a machine with 16 GB RAM and a synced node volume (for example a replay runner): push to the `make-addressdb` branch, or run `bash scripts/make-addressdb-snapshot.sh`, which indexes with the source build in batches of 5000 blocks (about 1.5 h for 1M blocks) and writes the snapshot to `~/zen-out`. Copy it to the public node server and publish it with `setup-site.sh`.

### Moving to a new domain

The pages use whatever domain they are served from, so only the server name, the seed and the default snapshot URL change.

1. DNS: add an A record for the new name pointing at the server (Cloudflare: **DNS only**). Keep the old record for now: nodes already running have the old name as their seed.
2. On the server, serve both names (one certificate covers both):

```
cd ~/zenprotocol && git pull
DOMAIN=new.example.org EXTRA_DOMAINS=zen.sealinkgps.com bash site/setup-site.sh
```

3. In the repository, edit `network.json`: add the new name first in `seeds`, `snapshotSources` and `publicNodes` (keep the old one below it). Installed nodes read the seeds from it at every start and the snapshot loader reads the sources, so no image or script change is needed. Also add the new seed as the first line of `seeds` in `src/Node/main.yaml` (used when `network.json` cannot be reached). Update the links in `Docker/README.md` and this file.
4. After a few months, when old installations have updated, drop the old name: run `DOMAIN=new.example.org bash site/setup-site.sh` without `EXTRA_DOMAINS` and remove the old seed and DNS record.

The replay reference lives in the `reference-data` branch of the repository, not on the domain, so it is unaffected.

## Community infrastructure

| Component | Address |
| --- | --- |
| Network status and downloads | [zen.sealinkgps.com](https://zen.sealinkgps.com) |
| Seed node | `zen.sealinkgps.com:9655` (pre-configured in the image) |
| Public node for wallets | `https://zen.sealinkgps.com/node/` (whitelisted read-only API + `publishtransaction`) |
| Network stats | [zen.sealinkgps.com/stats.html](https://zen.sealinkgps.com/stats.html) |
| Latest snapshot | [zen.sealinkgps.com/snapshots](https://zen.sealinkgps.com/snapshots/) |
| Source | [github.com/alonp1/zenprotocol](https://github.com/alonp1/zenprotocol/tree/node-upgrade-script) |

The status page exposes only two read-only node endpoints (`/api/info`, `/api/peers`). The `/node/` path exposes a fixed whitelist of read-only chain and address endpoints plus `publishtransaction` (needed to send and vote), rate-limited. Wallet, mining and resync endpoints are never reachable.

## Keeping the chain alive without the original project

The blockchain lives in every node; what can disappear is the infrastructure around it. Everything below is ours, so a node can be installed and built even if the original project's servers (MyGet, `zp.io`, the old seeds, the S3 snapshot) are gone.

| What could disappear | Our copy | Where |
| --- | --- | --- |
| The MyGet feed: Zulib, CGPContract, FsBech32, z3, secp256k1 (all versions) | `packages__*.nupkg` | Release `upstream-mirror` |
| The released node binaries (`@zen/zen-node`, npm on MyGet) | `npm__zen-zen-node-<version>.tgz`; the Dockerfile falls back to it automatically | Release `upstream-mirror` |
| Source of every repository of the `zenprotocol` GitHub organization (node, compiler, ZFStar, Zulib, wallet, explorer...) | `repos__<name>.bundle` (git bundle, all branches and tags): `git clone repos__<name>.bundle <name>` | Release `upstream-mirror` |
| A prebuilt node image | `ghcr.io/alonp1/zen-node` | GitHub packages (workflow `image`) |
| The chain snapshot (original S3 file is from Feb 2023) | Newest snapshot with sha256, from this server **and** from GitHub in pieces | `snapshotSources` in `network.json` |
| The seeds | Our seed first, the old ones after it; nodes refresh the list from `network.json` at every start | `seeds` in `network.json` |
| Names of assets and contracts (only on zp.io) | `site/asset-names.json`, `site/contract-names.json` | This repository |
| Block, transaction, CGP and asset history | The index of this server, rebuilt from any node in a few hours | `site/chain-index.mjs` |

The release `upstream-mirror` is built by the workflow **mirror-upstream** (GitHub Actions: Actions, mirror-upstream, Run workflow). It also runs on the 1st of every month and lists every problem in `MANIFEST.json`. To build the node from the mirror instead of MyGet, download the packages once:

```
gh release download upstream-mirror -R alonp1/zenprotocol -p 'packages__*' -D packages-mirror
cd packages-mirror && for f in packages__*; do mv "$f" "${f#packages__}"; done
dotnet restore --source ./packages-mirror --source https://api.nuget.org/v3/index.json
```

**Single points of failure left, and what to do:**

1. **One seed server.** A second public node in a different data center (another provider) is the real protection: run `install-node.sh` there with `PUBLIC_NODE=1`, then add its name to `seeds` in `network.json`. Every node then also learns peers from the network itself and keeps them in its address book.
2. **Snapshots.** After each snapshot refresh run `bash scripts/publish-snapshot-release.sh` on the server (needs `gh auth login` once) to update the GitHub copy. Anyone who runs a node can publish a snapshot the same way.
3. **The GitHub repository.** Anyone can `git clone` it; keep at least one more clone or fork in another account.

Every download is checked against its sha256 before use. A snapshot is only a shortcut: the node keeps validating every new block, and the replay gate (`scripts/check-against-reference.sh`: hashes of the first 1,053 blocks and the CGP state) shows that a node built from the sources reproduces the same chain.

## One-command node install: what it does and what is checked

```
curl -fsSL https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/scripts/install-node.sh | bash
```

| Step | What happens | Stops or falls back when |
| --- | --- | --- |
| 1. Checks | 20 GB free disk; ports 9655 and 11567 free (first install only) | Not enough disk or port in use: stops with a message |
| 2. Docker | Installs Docker and the compose plugin on Linux; on macOS/Windows asks for Docker Desktop | |
| 3. Code | Clones the repository to `~/zenprotocol`, or fast-forwards an existing copy | |
| 4. Firewall | Opens 9655 in `ufw` when it is active; otherwise reminds you about a cloud firewall | |
| 5. Settings | Writes `.env`: external IP, miner threads (0), public-node flag | |
| 6. Image | `docker compose pull`: the ready image `ghcr.io/alonp1/zen-node` (official 1.0.13 binaries, Mono 6.12) | Registry not reachable: builds the image locally, taking the binaries from MyGet or, if gone, from our `upstream-mirror` release |
| 7. Snapshot | Loads the newest chain snapshot (about 2.5 GB, chain data only, never a wallet) unless chain data already exists. Sources in order: `SNAPSHOT_URL`, each entry of `snapshotSources` in `network.json` (this server, then the GitHub release), the official Feb-2023 file. Every source is checked against the sha256 in its `latest.json`, the zip is test-extracted, the chain folder is located and only then replaces `/data/main` (wallet files are skipped) | A source that is down or has a wrong checksum is skipped; with none left the old official snapshot is used and the node syncs the rest |
| 8. Start | `docker compose up -d`; at start the node refreshes its seeds from `network.json`; waits for the API and prints `blockchain/info` | API not up after about 2 minutes: prints where to read the logs |

Done when `blocks` equals `headers` and `initialBlockDownload` is `false`. Run the command again to update (code and image; chain data is kept). Options: `MINER_THREADS`, `PUBLIC_NODE=1`, `SKIP_SNAPSHOT=1`, `DIR`.

### Tests that were run

| Test | Result |
| --- | --- |
| Snapshot loader against the live server in CI (`snapshot-test`): load, start, sync | Passes; the node reaches the chain tip (about block 1,053,169, `initialBlockDownload` false) within 150 s |
| Prebuilt image in CI (`image`): start, API answers, syncs from our seed | Passes; blocks arrive from the seed |
| Seeds refresh from `network.json` and the sources parser (local test with a changed file) | Passes |
| Mirror contents (`mirror-upstream`): the exact packages pinned in `paket.lock`, `@zen/zen-node` 1.0.13, 21 repositories | Present in the release; `MANIFEST.json` lists size and sha256 of each |
| Replay of the whole chain by the source build (`check-against-reference.sh`: 1,053 block hashes and the CGP state) | Passed for the Mono build; the .NET 10 replay is running |
| Wallet: 20 tests including hostile node responses | Pass |
| `install-node.sh` itself on a clean server | **Not yet run end to end**: see the checklist below |

### Testing on a fresh server

Use a new Ubuntu 22.04/24.04 server with 2 GB RAM and 40 GB disk, as root, nothing else installed:

1. Run the command above. Expected: `== Checks` through `== Start`, then a `blockchain/info` line with `"chain":"main"`.
2. Within a few minutes `curl -s http://127.0.0.1:11567/blockchain/info` shows `blocks` close to the public tip; `docker compose ps` shows **Up**.
3. `docker compose logs zen-node | head` shows `seeds from network.json: zen.sealinkgps.com`.
4. Run the command a second time: it must update and restart without reloading the snapshot.
5. Compare the tip with `https://zen.sealinkgps.com/stats.html`.
6. Optional failure tests: block `ghcr.io` (`echo '0.0.0.0 ghcr.io' >> /etc/hosts`) to see the local build fallback; start with a wrong `SNAPSHOT_URL` to see the next source being used.

Report any error with the last lines of the output.

### Do we need the developers' packages on our node?

A running node needs none of them: the image already contains the compiled 1.0.13 release. They are needed only to **build the node from source** (the .NET 10 work, stage 5). Our copy covers that: `bash scripts/restore-from-mirror.sh` downloads exactly the pinned packages, checks their sha256 and writes `./packages-mirror`; then `dotnet restore src/Node/Node.fsproj --source ./packages-mirror --source https://api.nuget.org/v3/index.json`. Packages from nuget.org (FSharp, NetMQ, ZFStar...) are permanent there; ZFStar, Zen.FSharp.Compiler.Service and ZFS-Tools are mirrored as well.

## Linux server (node only)

1. Connect: `ssh root@<server-ip>`
2. Recommended first: `apt update && apt upgrade -y`, then `reboot`
3. Install, in one command:

```
curl -fsSL https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/scripts/install-node.sh | bash
```

The script (`scripts/install-node.sh`) checks for 20 GB of free disk and free ports 9655 and 11567, installs Docker, clones the code to `~/zenprotocol`, pulls the ready node image (builds it when the registry is unreachable), loads the newest chain snapshot (verified against its sha256, tried from every source in `network.json`), starts a node capped at 1 CPU and 2 GB RAM and shows the sync status. Run it again to update; the chain data is kept. Options: `PUBLIC_NODE=1`, `MINER_THREADS=2` (own hardware only), `SKIP_SNAPSHOT=1`, `DIR=/other/folder`.

**Firewall:** allow inbound TCP 9655 (in the Hetzner Cloud Firewall, if you use one). The API port (11567) stays reachable from the server only.

**Do not mine on cloud servers.** Hetzner and DigitalOcean terms forbid it.

### Status page and snapshot hosting (once)

Requires a DNS A record pointing at the server. On Cloudflare set it to **DNS only** (grey cloud): the proxy does not carry port 9655.

```
cd ~/zenprotocol
DOMAIN=your.domain bash site/setup-site.sh
```

The script adds a separate Nginx site (existing sites are untouched), publishes the newest snapshot, installs the `zen-stats` timer (rebuilds `stats.json` for the stats page every 5 minutes from the local API; visitors never reach the node) and issues an auto-renewing HTTPS certificate. Without `DOMAIN` it uses `zen.sealinkgps.com`.

It also installs the `zen-index` timer: `site/chain-index.mjs` (Node 22 in a Docker container, decoding blocks with the wallet's tested serializer) reads the chain in batches of 2,000 blocks from the local API into `/var/lib/zen-stats/chain-index.sqlite` and keeps every block (hash, parent, time, difficulty, transactions, reward, fees, ZP moved, miner) and every transaction (input and output addresses with assets and amounts, contract and command) for a future explorer. It writes `assets.json` (all assets: tokens outstanding, holders, transactions) and `cgp-history.json` (every CGP interval: ballots with voter and weight at the snapshot block, allocation in force and decided, payouts) for the pages `assets.html` and `cgp.html`. The first index from genesis takes a few hours in 5-minute steps (`journalctl -u zen-index` shows progress); afterwards each run adds the new blocks. The block explorer page `explorer.html` (latest blocks, every block with its summary and transactions, transactions, search) reads this index through `site/explorer-api.mjs`, a read-only service on 127.0.0.1:11580 (`zen-explorer`, published by nginx as `/explorer/api/`); blocks not indexed yet are read from the node. Names of assets and contracts: `site/asset-names.json`, `site/contract-names.json`. To rebuild the index: `rm /var/lib/zen-stats/chain-index.sqlite*`. (`/blockchain/block?blockNumber=` walks back from the tip for every call, about 10 s each, so it is not used.)

### Refreshing the snapshot (monthly)

```
cd ~/zenprotocol
H=$(curl -s http://127.0.0.1:11567/blockchain/info | grep -o '"blocks":[0-9]*' | cut -d: -f2)
docker compose down
docker compose run --rm --no-deps --entrypoint /create-snapshot.sh zen-node $H
docker compose up -d
bash site/setup-site.sh
```

The node is down for about 10 minutes while zipping. Snapshots never contain wallets. Old snapshots in `zen-data/snapshots` can be deleted manually (about 2.5 GB each).

## Home computer (node + miner)

On Windows run the node only through Docker Desktop: the native npm install fails to create wallets (`cannot derive`).

1. Windows: `winget install Git.Git Docker.DockerDesktop`, then reboot. macOS/Linux: install Git and Docker.
2. Open Docker Desktop and wait for **Engine running** (accept the WSL install and Ubuntu user prompt if asked)
3. Install and load the snapshot from **one** terminal (two parallel downloads corrupt the file). Windows PowerShell:

```
git clone -b node-upgrade-script https://github.com/alonp1/zenprotocol.git
cd zenprotocol
Set-Content .env "ZEN_CPUS=3.0`nZEN_DATA=zen-data"
docker compose pull
docker compose run --rm --no-deps --entrypoint /load-snapshot.sh zen-node
docker compose up -d
```

If `docker compose pull` fails (registry not reachable) run `docker compose build` instead. `ZEN_DATA=zen-data` keeps the data in a Docker volume. Without it the data lives in a Windows folder and sync is about 4x slower. On macOS/Linux write the same two lines to `.env` with any editor.

4. Check: `docker compose ps` shows **Up** (not Restarting), and `curl.exe -s http://127.0.0.1:11567/blockchain/info` shows `blocks` equal to `headers`
5. Create a new wallet for mining rewards (not your main wallet):

```
docker compose exec zen-node mono zen-cli.exe wallet-create
docker compose exec zen-node mono zen-cli.exe mnemonicphrase
```

Write the 24 words on paper, clear the screen (`cls`), and only then:

```
docker compose exec zen-node mono zen-cli.exe address
```

6. Start mining once the node is in sync:

```
Set-Content .env "MINER_THREADS=2`nZEN_CPUS=2.0`nZEN_DATA=zen-data"
docker compose up -d
```

`GetBlockTemplate` lines in the log mean the miner is working. A mined block's reward unlocks after 100 blocks.

**Windows settings for continuous mining:**

- Settings → System → Power → Sleep: **Never** when plugged in
- Docker Desktop → Settings → General: **Start Docker Desktop when you sign in**

**Replacing the miner wallet** (for example if its words were exposed):

```
docker compose exec zen-node mono zen-cli.exe removewallet
docker compose exec zen-node mono zen-cli.exe wallet-create
```

`removewallet` asks for the current wallet's password.

**Desktop Zen Wallet on the home node.** The wallet's default remote node (`mainnet-nodes.zp.io`) disconnects often ("Node is inaccessible"). Point it at your own node. First load a snapshot that already contains the address index (see *Public node for wallets*; release 1.0.13 cannot build the index from scratch and restarts in a loop), then:

```
Add-Content .env "WALLET_API=1"
docker compose up -d
docker compose logs -f | Select-String "AddressDB"
```

Wait for `AddressDB synced to block ...`, then in the wallet: ⚙ → Node Connectivity → **Mainnet | Local Node | http://localhost:11567**. The wallet keeps its own keys; the node only serves chain data.

## Useful commands

Run from the `zenprotocol` folder. On Windows use `curl.exe` instead of `curl`.

| Purpose | Command |
| --- | --- |
| Sync status | `curl -s http://127.0.0.1:11567/blockchain/info` |
| Connected peers | `curl -s http://127.0.0.1:11567/network/connections/count` |
| Miner wallet balance | `docker compose exec zen-node mono zen-cli.exe balance` |
| Wallet history | `docker compose exec zen-node mono zen-cli.exe history` |
| Logs | `docker compose logs -f --tail 50` |
| Container status | `docker compose ps` |
| Stop / start | `docker compose down` / `docker compose up -d` |
| Update to latest code | `git pull`, then `docker compose up -d --build` |

In sync when `blocks` equals `headers` and `initialBlockDownload` is `false`. Compare with [zen.sealinkgps.com](https://zen.sealinkgps.com) or [zp.io](https://zp.io).

## Security and known issues

**Security**

- Keep every wallet's 24 words on paper only. Never send them, never show them in a screenshot. Whoever has them controls the coins.
- Never import your main ZP wallet into a node. Vote from your regular wallet.
- The API port (11567) is bound to localhost. It controls the wallet; never expose it.
- Do not delete the data: the `zenprotocol_zen-data` Docker volume, or `zen-data` on a server.

**Known issues**

| Issue | Cause | Fix |
| --- | --- | --- |
| `npm.ps1 cannot be loaded` | PowerShell blocks scripts | Use `npm.cmd` instead of `npm` |
| `is not a valid npm option` | New npm syntax, `@` in PowerShell | `npm.cmd config set "@zen:registry=https://..."` |
| `cannot derive` on Windows | Native node unsupported on Windows | Use Docker Desktop |
| Container stuck in Restarting | Windows line endings in a script | `git pull`, then `docker compose up -d --build` |
| `invalid compressed data` | Corrupt download (e.g. two at once) | File is deleted automatically; run the load again |
| `no configuration file provided` | Command run outside `zenprotocol` | `cd zenprotocol` |
| `account already exist` | Node already has a wallet | `removewallet`, then `wallet-create` |
| Slow sync on Windows | Data in a Windows folder | `ZEN_DATA=zen-data` in `.env`, reload the snapshot |
| Desktop wallet: `Node is inaccessible` | Remote node `mainnet-nodes.zp.io` unreliable | Snapshot with address index, `WALLET_API=1`, switch wallet to Local Node |
| Node restarts every ~10 min after `Creating AddressDB` | 1.0.13 cannot index the full chain at once | Remove `WALLET_API`/`PUBLIC_NODE`, load a snapshot with the index |
| Public node: `/node/addressdb/balance` returns 504 for some addresses | Addresses with very many outputs (e.g. a miner's) take longer than nginx's 60 s; requests are served one at a time, so a heavy one delays the rest | Planned before launch: per-request time limit and a separate queue for heavy queries |
| Versions before 1.0.13 stop working | Built-in expiry date | Use 1.0.13 only |
