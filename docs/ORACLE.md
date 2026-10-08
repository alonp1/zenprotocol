# Oracle: price data on the chain

An oracle brings off-chain facts (here: prices) to contracts. On ZP it is three parts: the **Oracle contract** (records commitments), a **service** (fetches prices, builds the commitment, answers proof requests), and **consumer contracts** such as **FixedPayout** (a bet that pays out against an attested price).

Status: the contracts are the developers' originals (repository `zenprotocol/contracts`). The old service (`zp-oracle`, F# on Mono, Intrinio data, MongoDB) is dead. The replacement lives in `src/Oracle` (this repository, .NET 10, SQLite, no paid data source). It is tested on our testnet only.

## How it works

1. Every interval (default hourly) the service reads the price of each ticker, e.g. `EUR = 1.083` (USD per euro).
2. For each ticker it builds a **leaf**: the Zulib `Sha3` of the identifier string followed by the U64 `value × 1000` (exactly `hashLeaf` in FixedPayout.fst). The leaves, in the configured order, form a **Merkle tree** (the tree of the node's `Consensus` library, so the root is identical to what contracts compute).
3. The service executes the Oracle contract with command `Commit` and the **root** as `Commit`. The transaction is signed with the oracle's key. The contract mints a *commitment token* derived from `(root ‖ oracle public key)` and keeps it. Now the chain proves *that root existed at that block*.
4. Anyone who needs the value asks the service `GET /auditpath?...` for: timestamp, value, root, index, audit path.
5. A consumer executes the Oracle contract with `Attest` (root, oracle public key, recipient) to receive an *attestation token* (`[[[ root ; pubkey ]]]`), proving the commitment is on the chain.
6. The consumer contract (FixedPayout `Redeem`) checks the attestation token, rebuilds the Merkle root from the leaf and the audit path, compares the value against the bet's price, and releases the collateral.

Trust: the oracle is trusted for the *value*. The chain proves the *time* (the commitment) and that the value was not changed afterwards. Anyone can audit a published value against the committed root.

## The contracts

| Contract | Commands | Role |
|---|---|---|
| Oracle | `Commit`, `Attest` | Records a root (optionally with an attestation fee) and mints attestation tokens |
| FixedPayout | `Issue`, `Redeem`, `Cancel` | Bull/Bear position tokens on a ticker, price and time window; collateral goes to the winning side. Needs a z3 limit of 30,000,000 to verify |
| Bet | `Buy`, `RedeemBull`, `RedeemBear` | Older simple version of the same idea |

Message bodies (dictionaries) are listed in each contract's README (`zenprotocol/contracts`). Notes:

- The old service sent the command `Add`; the contract expects `Commit`. The new service uses `Commit`.
- **What is committed.** FixedPayout expects the commitment to be `SHA3(root ‖ uint64 timestamp)` (its `hashCommit`), not the bare root. The old service committed the bare root, so a payout could not have worked against it. The new service builds the commit hash with the same Zulib function the contract uses, and serves `timestamp` and `root` with every proof.
- **Tickers are at most 4 characters** (FixedPayout refuses longer ones), so the service uses symbols (`EUR`, `GBP`, `BTC`) quoted in one currency (`ORACLE_QUOTE`, USD by default). Values keep 3 decimals (value × 1000 in a 32 bit number), which suits `EUR`, `GBP`, `BTC` but not a currency that is worth a fraction of a cent, such as `JPY`; for those, quote the other way round.
- A commitment token is bound to the oracle's public key, so a second oracle can use the same contract without clashing.
- FixedPayout does not know tickers by name in the tree; it recomputes the leaf from `Ticker` and `Value`, so the service and the contract must build leaves identically (see step 2).

## Economics: what the oracle can and cannot carry today

The oracle is only a price source. The money in a bet is whatever asset the consumer contract is given as collateral, and any asset on the ZP chain works (ZP, or a token).

- **ZP is volatile and, today, has no market value.** A bet or a loan in ZP says little. A stable unit is needed for most financial uses.
- **There is no USDC on ZP** and no bridge. Options for a stable unit: a token backed by USDC held by one custodian (works, but it is trust and regulation), an over-collateralised synthetic dollar (needs a collateral that has value and liquidity, so not yet), or a test unit for experiments.
- **zUSD on the testnet** is that test unit: a token of the `Token` or `NamedToken` contract with no value, used as the collateral in the bet scenario (`scripts/testnet-bet.sh`). An authorised issuer can be modelled with `AuthenticatedSupply` (only one key may issue and destroy).
- Nothing here is for real money before an independent review of the contracts and the service, and legal advice.

## The service (`src/Oracle`)

Planned layout and behavior:

| Part | Choice |
|---|---|
| Runtime | .NET 10, a single small program, uses `src/Consensus` for hashing and the Merkle tree |
| Storage | SQLite: one table of rounds (timestamp, root, tx hash), one of leaves (round, index, ticker, value) |
| Data sources | Pluggable. `mock` (deterministic, for the testnet and tests) and free real sources (currency rates, crypto prices) |
| Chain access | The node API: `/wallet/contract/execute` with `sign` and the wallet password, `/contract/active` to find the contract |
| Public API | `GET /rounds/latest`, `GET /auditpath?ticker=&timestamp=`, `GET /health` |
| Config | One YAML or JSON file: tickers, interval, provider, node URL, contract address, key path |

## Running it on the testnet

1. Start a testnet node with a known wallet (see [TESTNET.md](TESTNET.md)).
2. Activate the Oracle contract: `scripts/testnet-contract.sh` shows the activation call; the Oracle contract is activated the same way with `CONTRACT=<path to Oracle.fst>`.
3. Start the oracle service with the `mock` provider (or `frankfurter` for ECB currency rates, `coingecko` for crypto prices, `auto` for both in one list: currencies from Frankfurter, crypto symbols from CoinGecko, `coinmarketcap` with a key) pointing at the node and the contract address.
4. Watch `/rounds/latest`; each round shows a transaction hash that appears in the explorer.

Never use real money with this until the contract and the service have had an independent review.


## Data sources

The oracle takes its prices from one provider (`ORACLE_PROVIDER`: `mock`, `frankfurter` for ECB currency rates, `coingecko` for crypto, `coinmarketcap` with a key, or `auto` = currencies from Frankfurter and crypto symbols from CoinGecko). Any other source that answers JSON over HTTP is added without code, and each ticker can come from a different source, through a file named in `ORACLE_SOURCES_FILE`:

```json
{
  "sources": {
    "binance": { "url": "https://api.binance.com/api/v3/ticker/price?symbol={TICKER}USDT", "path": "price" },
    "kraken":  { "url": "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", "path": "result.XXBTZUSD.c[0]" },
    "mykeyed": { "url": "https://api.example.com/v1/price/{ticker_lower}?currency={quote_lower}",
                 "path": "data.price", "headers": { "X-API-KEY": "env:EXAMPLE_KEY" }, "multiply": 1, "invert": false }
  },
  "tickers": { "BTC": "binance", "EUR": "frankfurter", "GBP": "frankfurter" }
}
```

- `url` may use `{ticker}`, `{TICKER}`, `{ticker_lower}`, `{quote}`, `{quote_lower}`.
- `path` is where the number is in the answer: dots for objects, `[n]` for lists; a number written as a string (`"82984.01"`) is accepted.
- `headers` values written `env:NAME` are read from the environment, so keys stay out of the file. `multiply` scales the value (cents to dollars), `invert` takes 1/x (a source that quotes the other way round).
- A ticker not listed in `tickers` comes from `ORACLE_PROVIDER`. A ticker the source cannot give is left out of that round and the log says which and what the source answered; the other tickers are still published.
- The paths above are examples: check them against the real answer of the source (`curl` it once) before relying on them. Sources have rate limits and terms of use; for anything that matters, use a paid source with a key.

### Several sources for one ticker (quorum)

Give a ticker a **list** of sources instead of one name and it is priced only when they agree:

```json
{
  "quorum": { "min": 2, "tolerance": 0.01 },
  "tickers": { "BTC": ["coingecko", "binance", "kraken"], "EUR": ["frankfurter", "ecb2"] }
}
```

The sources are asked together; their median is the reference, a source more than `tolerance` (1 %) away from it is dropped, and at least `min` sources must remain. A source that fails counts as not answering. If there is no agreement the ticker is **skipped in that round** (the log shows every answer), so a doubtful number is never committed: bets settle on what is committed and cannot be undone. Built-in source names: `coingecko`, `frankfurter`, `coinmarketcap` (key), and any `sources` entry of the file. Pyth (free, signed prices from many publishers) fits as a `sources` entry through its Hermes API; check the answer's path and exponent with `curl` first.


### End-of-day tickers (stocks, indices, commodities)

Free sources give no continuous trading for these, and none is needed: a ticker listed under `"daily"` is fetched **once per weekday after `closeUtc`** (default 21:30 UTC, after the US close) and every round carries the last close until the next one. The round's evidence says which day the value belongs to (`asOf`). Weekends and holidays publish nothing new (a holiday's source answer repeats the previous close, which is what it should be). The last closes are kept in `daily.json` in the data directory. Tickers are at most 4 characters: `SPY`, `AAPL`, `MSFT`, `XAU` (gold), `WTI` (oil).

A source entry can read **CSV** (`"format": "csv"`, `"path"` = the column name or a 0-based index; the last data row is used) and map tickers to its own symbols (`"symbols": { "XAU": "xauusd" }`, used as `{symbol}` and `{symbol_lower}` in the URL). A negative index counts from the end (`close[-1]`). A `User-Agent` header replaces the default one (Yahoo refuses unknown agents).

`site/oracle-sources.json` is the ready file: crypto from CoinGecko, Binance and Coinbase (2 of 3 must agree within 1 %), currencies from Frankfurter (ECB) and open.er-api.com, daily closes from Stooq and Yahoo Finance (2 of 2). Free sources change without notice, so **check them from the server first**:

```
ORACLE_SOURCES_FILE=/r/site/oracle-sources.json ORACLE_TICKERS=BTC,ETH,EUR,GBP,JPY,CHF,SPY,AAPL,MSFT,XAU,WTI zen-oracle probe
```

`probe` asks every ticker once and prints what each source said (`ok BTC 121000 coingecko=… binance=… coinbase=…`, or why it failed); nothing is signed or sent. A source that fails there is replaced in the file before the oracle is switched over.

### Evidence

Every round stores, next to the values, `Evidence` (JSON, in `/rounds` and `/rounds/latest`): for each ticker the value, the day (`asOf`), what each source answered and which sources were dropped as outliers. The commitment on the chain only holds the Merkle root; this is what shows later why a value was published. Keep the rounds directory backed up: a free source may change or remove its history, the oracle's own record must stay.
