# Oracle: price data on the chain

An oracle brings off-chain facts (here: prices) to contracts. On ZP it is three parts: the **Oracle contract** (records commitments), a **service** (fetches prices, builds the commitment, answers proof requests), and **consumer contracts** such as **FixedPayout** (a bet that pays out against an attested price).

Status: the contracts are the developers' originals (repository `zenprotocol/contracts`). The old service (`zp-oracle`, F# on Mono, Intrinio data, MongoDB) is dead. The replacement lives in `src/Oracle` (this repository, .NET 10, SQLite, no paid data source). It is tested on our testnet only.

## How it works

1. Every interval (default hourly) the service reads the price of each ticker, e.g. `EUR = 1.083` (USD per euro).
2. For each ticker it builds a **leaf**: `Hash(identifier bytes ‖ ';' ‖ uint32 big-endian(value × 1000))`. The leaves, in the configured order, form a **Merkle tree** (the tree of the node's `Consensus` library, so the root is identical to what contracts compute).
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
3. Start the oracle service with the `mock` provider (or `frankfurter` for ECB currency rates, `coingecko` for crypto prices, `coinmarketcap` with a key) pointing at the node and the contract address.
4. Watch `/rounds/latest`; each round shows a transaction hash that appears in the explorer.

Never use real money with this until the contract and the service have had an independent review.
