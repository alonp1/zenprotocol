# What was tested, and what it showed

Two kinds of tests: **CI** (GitHub Actions, every push; a 3-node devnet that mines real blocks) and **live checks** on the testnet server (91.98.3.17). Results as of 2026-10-08.

## CI (workflow `testnet`, scenarios in `scripts/`)
| Scenario | What it does | Result |
|---|---|---|
| Token | activate Token, buy tokens with ZP, see them in the wallet | pass |
| Oracle | activate Oracle, the service commits a round, the proof endpoint returns a valid audit path | pass |
| NamedToken (zUSD) | mint a named asset against ZP | pass |
| AuthenticatedSupply | Issue and Destroy by the one authorised key | pass |
| Dex | Make, Take (full) and Cancel of orders; the cancelled underlying returns to the maker key | pass |
| Bet | buy zUSD, activate FixedPayout, Issue Bull/Bear, **Attest** the oracle commitment, **Redeem** the winning side; the collateral comes back | pass, after two fixes (below) |
| Bridge (mock EVM) | activate the bridge contract, a deposit from a linked address issues zUSDC | pass |
| Load | 5 and 20 tx/s for 10 s from 3 nodes | all accepted and confirmed, p95 latency 15 ms |
| Oracle workflow | build, self-test (leaf encoding, audit paths, sources, quorum), tools image | pass |

Fixes the tests forced: the wallet only sees outputs locked to its tracked keys, so the bet signs with the wallet's own key; and **the oracle's Merkle leaves did not match FixedPayout's `hashLeaf`** (Sha3 over the identifier then a U64, not `ticker;value`), which made every Redeem fail with "Invalid audit path".

## Live on the server
| Check | Result |
|---|---|
| Oracle publishes 5 tickers (EUR, GBP, CHF, AUD, BTC), CoinGecko and Frankfurter via the `auto` provider | working; a failing ticker is skipped, not fatal |
| Dex index and page: Make orders appear ~10 blocks after (the index trails the node) | working |
| Market maker: an ask at 0.101 and a bid at 0.099 USD per ZP around 0.10 | working; found and fixed duplicate orders (waiting for the index), a wait that started before the order was sent, and surplus copies are now cancelled |
| Bridge deposit on **Base Sepolia**: a link signed with the EVM key, 10 test USDC sent to the bridge, zUSDC issued to the linked ZP address | working |
| Bridge withdrawal: 5,000,000 zUSDC units sent to the bridge address, burned, 5 USDC paid back to the EVM address | working |
| Pages over plain HTTP on the server's IP (`site/setup-testnet-web.sh`) | working |

Fixes the live tests forced: public RPC nodes refuse log queries over ~500 blocks (the bridge now asks in 450-block ranges); and a withdrawal now checks the requested EVM address's own link, because one ZP address can be linked to several EVM addresses.

## Not yet tested
- Real value: everything is on test networks with test coins.
- The quorum rule on the server (it is built and self-tested, not switched on).
- Partial Take on the Dex, and orders from other users than the market maker.
- A clean install from nothing with the scripts only (`DEPLOY.md`).
- Bridge: pause, limits, proof of reserves, custody by several keys.
- A second seed server, a domain with HTTPS.
