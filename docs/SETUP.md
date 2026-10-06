# ZP – Running a Node and a Miner

Updated: 2026-10-06

## Overview

A node validates and relays the blockchain. A miner is a node that also mines blocks and earns 25 ZP per block. Run nodes on cloud servers, but mine only on hardware you own: most cloud providers forbid mining.

| Machine | Role | Method | Mining |
| --- | --- | --- | --- |
| Linux server (Ubuntu) | Public node, seed, status page, snapshots | Docker + Nginx | Not allowed |
| Home computer (Windows/macOS/Linux) | Node + miner | Docker Desktop | Allowed |

All installs use the official 1.0.13 release, the first without a version expiry date. A new node loads a recent snapshot and is in sync within minutes.

### Public node for wallets

Light wallets need a node with an address index (AddressDB). Release 1.0.13 cannot build it from scratch on today's chain (it loads every block into one message and crashes), so the index is built once with the source build, which indexes in batches, and shipped inside the snapshot. Release nodes then keep it up to date block by block.

1. On a machine with 16 GB RAM and a synced node volume (the replay runner): push to the `make-addressdb` branch, or run `bash scripts/make-addressdb-snapshot.sh`. The snapshot lands in `~/zen-out` (runner: `/home/runner/zen-out`).
2. Serve it temporarily from that machine: `cd /home/runner/zen-out && python3 -m http.server 8000` (allow TCP 8000 in its firewall).
3. On the community server (needs about 20 GB free during the load):

```
cd ~/zenprotocol && git pull
F=<file>.zip
mkdir -p zen-data/snapshots
curl -o zen-data/snapshots/$F http://<runner-ip>:8000/$F
curl -o zen-data/snapshots/$F.sha256 http://<runner-ip>:8000/$F.sha256
(cd zen-data/snapshots && sha256sum -c $F.sha256)
docker compose down
docker compose run --rm --no-deps -e SNAPSHOT_URL=/data/snapshots/$F --entrypoint /load-snapshot.sh zen-node
grep -q PUBLIC_NODE .env 2>/dev/null || echo "PUBLIC_NODE=1" >> .env
docker compose up -d --build
bash site/setup-site.sh
curl -s https://zen.sealinkgps.com/node/blockchain/info
```

`setup-site.sh` also publishes this snapshot (with the index) for everyone. `PUBLIC_NODE=1` runs the node with `--remote`: no node wallet, address index on, CORS open. Never set it on a mining node.

### Moving to a new domain

The pages use whatever domain they are served from, so only the server name, the seed and the default snapshot URL change.

1. DNS: add an A record for the new name pointing at the server (Cloudflare: **DNS only**). Keep the old record for now: nodes already running have the old name as their seed.
2. On the server, serve both names (one certificate covers both):

```
cd ~/zenprotocol && git pull
DOMAIN=new.example.org EXTRA_DOMAINS=zen.sealinkgps.com bash site/setup-site.sh
```

3. In the repository, add the new name as the first seed in `src/Node/main.yaml` and in `Docker/Dockerfile` (keep the old one below it), and set the default `URL` in `Docker/load-snapshot.sh`. Update the links in `Docker/README.md` and this file.
4. After a few months, when old installations have updated, drop the old name: run `DOMAIN=new.example.org bash site/setup-site.sh` without `EXTRA_DOMAINS` and remove the old seed and DNS record.

The replay reference lives in the `reference-data` branch of the repository, not on the domain, so it is unaffected.

## Community infrastructure

| Component | Address |
| --- | --- |
| Network status and downloads | [zen.sealinkgps.com](https://zen.sealinkgps.com) |
| Seed node | `zen.sealinkgps.com:9655` (pre-configured in the image) |
| Public node for wallets | `https://zen.sealinkgps.com/node` (planned, see below) |
| Network stats | [zen.sealinkgps.com/stats.html](https://zen.sealinkgps.com/stats.html) |
| Latest snapshot | [zen.sealinkgps.com/snapshots](https://zen.sealinkgps.com/snapshots/) |
| Source | [github.com/alonp1/zenprotocol](https://github.com/alonp1/zenprotocol/tree/node-upgrade-script) |

The status page exposes only two read-only node endpoints (`/api/info`, `/api/peers`). The `/node/` path exposes a fixed whitelist of read-only chain and address endpoints plus `publishtransaction` (needed to send and vote), rate-limited. Wallet, mining and resync endpoints are never reachable.

## Linux server (node only)

1. Connect: `ssh root@<server-ip>`
2. Recommended first: `apt update && apt upgrade -y`, then `reboot`
3. Install:

```
curl -fsSL https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/scripts/setup-zen-node-server.sh -o setup.sh
bash setup.sh
```

The script checks for 20 GB of free disk and free ports 9655 and 11567, installs Docker, clones the code to `~/zenprotocol` and starts a node capped at 1 CPU and 2 GB RAM, so it does not disturb other services on the server.

4. Load the snapshot (instead of a multi-hour sync):

```
cd ~/zenprotocol
docker compose down
docker compose run --rm --no-deps --entrypoint /load-snapshot.sh zen-node
docker compose up -d
```

**Firewall:** allow inbound TCP 9655 (in the Hetzner Cloud Firewall, if you use one). The API port (11567) stays reachable from the server only.

**Do not mine on cloud servers.** Hetzner and DigitalOcean terms forbid it.

### Status page and snapshot hosting (once)

Requires a DNS A record pointing at the server. On Cloudflare set it to **DNS only** (grey cloud): the proxy does not carry port 9655.

```
cd ~/zenprotocol
DOMAIN=your.domain bash site/setup-site.sh
```

The script adds a separate Nginx site (existing sites are untouched), publishes the newest snapshot, installs the `zen-stats` timer (rebuilds `stats.json` for the stats page every 5 minutes from the local API; visitors never reach the node) and issues an auto-renewing HTTPS certificate. Without `DOMAIN` it uses `zen.sealinkgps.com`.

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
docker compose build
docker compose run --rm --no-deps --entrypoint /load-snapshot.sh zen-node
docker compose up -d
```

`ZEN_DATA=zen-data` keeps the data in a Docker volume. Without it the data lives in a Windows folder and sync is about 4x slower. On macOS/Linux write the same two lines to `.env` with any editor.

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
| Versions before 1.0.13 stop working | Built-in expiry date | Use 1.0.13 only |
