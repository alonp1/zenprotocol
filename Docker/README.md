# Running a ZP node / miner with Docker

Works on Linux, macOS and Windows (Docker Desktop). On Windows use Docker – the native Windows node fails to create wallets (`cannot derive`). Uses the official 1.0.13 release (no version expiry).

Full guide (server, home miner, snapshots, troubleshooting): [docs/SETUP.md](../docs/SETUP.md) · .NET 8 migration plan: [docs/MIGRATION.md](../docs/MIGRATION.md)

Network status, seed and snapshots: **https://zen.sealinkgps.com**

## 1. Install and load a snapshot

```bash
git clone -b node-upgrade-script https://github.com/alonp1/zenprotocol.git
cd zenprotocol
docker compose build
docker compose run --rm --no-deps --entrypoint /load-snapshot.sh zen-node
docker compose up -d
```

The snapshot (~2.4 GB, chain data only, no wallets) lets the node skip almost all of the initial sync. If the community snapshot is unavailable the loader falls back to the official Feb-2023 one. Run it from one terminal only – two parallel downloads corrupt the file.

**Windows:** first run `Set-Content .env "ZEN_DATA=zen-data"` so data lives in a Docker volume. A Windows folder is ~4x slower for the database.

Check sync:
```bash
curl -s http://127.0.0.1:11567/blockchain/info
```
Synced when `blocks` equals `headers` and `initialBlockDownload` is `false`.

## 2. Create a wallet for mining rewards

The miner pays rewards to the node's own wallet. Use a **new** wallet here, not the one holding your main ZP.

```bash
docker compose exec zen-node mono zen-cli.exe wallet-create
docker compose exec zen-node mono zen-cli.exe mnemonicphrase
docker compose exec zen-node mono zen-cli.exe address
```
`mnemonicphrase` prints the 24 words. Write them down offline and clear the screen before sharing any screenshot. To replace the wallet: `removewallet`, then `wallet-create`.

## 3. Turn on mining (own hardware only)

```bash
MINER_THREADS=2 ZEN_CPUS=2.0 docker compose up -d
```
Or put `MINER_THREADS=2` and `ZEN_CPUS=2.0` in `.env`. Most cloud providers (Hetzner, DigitalOcean) forbid mining. Rewards unlock after 100 blocks.

## Settings (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `MINER_THREADS` | `0` | CPU mining threads, 0 = off |
| `ZEN_CPUS` | `1.0` | CPU cap for the container |
| `ZEN_MEM` | `2g` | Memory cap |
| `ZEN_DATA` | `./zen-data` | Data location; `zen-data` = Docker volume |
| `EXTERNAL_IP` | – | Public IP to advertise to peers |
| `WALLET_API` | `0` | `1` = serve the desktop Zen Wallet (see below) |

## Desktop Zen Wallet on this node

The desktop wallet's default remote node (`mainnet-nodes.zp.io`) is no longer reliable. To use your own node instead:

1. Add `WALLET_API=1` to `.env` and run `docker compose up -d`. The node builds an address index on first start (can take a while; watch for `AddressDB synced` in the log).
2. In the wallet: ⚙ → Node Connectivity → **Mainnet | Local Node | http://localhost:11567**.

The wallet keeps its own keys; the node only serves chain data. The API stays bound to localhost.

## Server extras

- `scripts/setup-zen-node-server.sh` – one-shot install on Ubuntu, mining off
- `site/setup-site.sh` – nginx status page, snapshot hosting and HTTPS for a domain
- `Docker/create-snapshot.sh` – export a wallet-free snapshot (node stopped)

## Notes
- The API (port 11567) is bound to localhost only. Never expose it – it controls the wallet.
- Port 9655 is P2P. Opening it lets other nodes connect to you.
- `zen.sealinkgps.com` is pre-configured as a seed in the image.
