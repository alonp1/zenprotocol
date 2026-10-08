# Testnet server: install, check, rehearse

The aim: a fresh Ubuntu 24.04 x86 server (8 GB RAM) becomes a working testnet node with oracle, Dex index, explorer API, bridge (mock) and market maker by running **one script**, without manual fixes. Before the real move (new domain, split of the oracle into a private repo) rehearse it on a throwaway server.

## Install
`scripts/install-testnet-stack.sh` (see its header). Update later: `git pull`, rebuild `zen-tools` (`docker build -f Docker/Dockerfile.tools -t zen-tools .`), run the script again, `docker compose ... up -d --force-recreate`.

## After the install: what must be true
| Check | Command | Expected |
|---|---|---|
| node mines | `curl -s 127.0.0.1:31567/blockchain/info` | `blocks` grows, ~1-2 min per block |
| oracle publishes | `curl -s 127.0.0.1:8085/rounds/latest` | a round with a `Tx` (after the first interval) |
| index catches up | `docker compose ... logs --tail 3 index` | `block N of M (synced)`, trails the node by ~10 blocks |
| Dex | `curl -s 127.0.0.1:11581/explorer/api/dex/orders` | `dex` is the contract id; orders appear ~10 blocks after a Make |
| bridge | `curl -s 127.0.0.1:8090/status` | `contract` and `asset` set, `evm: mock` |
| market maker | `docker compose ... logs --tail 5 marketmaker` | `make ask` / `make bid` once, then quiet |
| env | `grep -E '^(MM_|DEX_|BRIDGE_|ORACLE_)' testnet-stack.env` | MM_DEX, MM_ASSET, MM_PRICE all set |

## Known manual steps that the script must absorb (check them in the rehearsal)
- `MM_DEX` / `MM_ASSET` / `MM_PRICE` were empty after the first update run: the installer must write them whenever they are missing.
- The index database changed shape (Dex table): a fresh install is fine; an update needs the old `index.sqlite` removed (`docker run --rm -v <project>_stack-data:/d alpine rm -f /d/index.sqlite*`). A schema check at start would remove the need.
- The bridge reads its mock deposits from `/data/evm.json` **inside the bridge-data volume**, not from the host folder.
- The market maker waits up to 30 minutes for an order to show in the index (the index trails the node); do not restart it in a loop.

## Rehearsal checklist
1. New x86 server, nothing but `git clone` and the install command.
2. Run the table above; every row must pass without edits to any file.
3. Anything that needed a manual step goes into the script and into this page, then repeat on a clean server.
4. Delete the server.
