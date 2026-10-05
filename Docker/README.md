# Running a Zen node / miner with Docker

Works on Linux, macOS and Windows (Docker Desktop). Uses the official 1.0.13 release (no version expiry).

## 1. Start the node

```bash
git clone https://github.com/alonp1/zenprotocol.git
cd zenprotocol
docker compose up -d --build
docker compose logs -f        # watch it sync (can take hours on first run)
```

Check sync status:
```bash
curl -s http://127.0.0.1:11567/blockchain/info
```
Compare `blocks` with https://zp.io.

## 2. Create a wallet for mining rewards

The miner pays rewards to the node's own wallet. Use a **new** wallet here, not the one holding your main ZP.

```bash
docker compose exec zen-node mono zen-cli.exe wallet-create
docker compose exec zen-node mono zen-cli.exe address
```
Write down the 24-word phrase it prints, offline. Anyone with it controls the rewards.

## 3. Turn on mining

```bash
MINER_THREADS=2 docker compose up -d
```
Use fewer threads than the machine has cores so it stays usable.

## Notes
- Chain and wallet are stored in `./zen-data`. Back it up; never delete it casually.
- The API (port 11567) is bound to this machine only. Do not expose it - it controls the wallet.
- Port 9655 is the P2P port. Opening it on your router lets other nodes connect to you (helps the network).
- Many cloud providers (e.g. DigitalOcean, Hetzner) forbid mining in their terms. Mine on your own hardware.
