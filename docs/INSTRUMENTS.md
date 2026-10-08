# Financial instruments on the ZP testnet

Everything here runs on our testnet (testnet coins, no value) with the original Zen contracts from `zenprotocol/contracts`, copied unchanged into `src/ContractExamples/` (only `AuthenticatedSupply` needs its key filled in). Each row is a scenario in CI (`scripts/testnet-*.sh`, workflow `testnet`) that activates the contract and runs its operations on a three-node network.

| Instrument | Contract | What you can do | Status in CI |
|---|---|---|---|
| Token sold for ZP | `Token` | Pay ZP, receive the contract's token 1:1; redeem back | works |
| Named token | `NamedToken` | Create a token with a name (up to 32 characters) in any amount, e.g. `zUSD` | works |
| Issuer-controlled token | `AuthenticatedSupply` | Only the holder of one key can issue or destroy the token (a model for a stable token with an authorised issuer) | works: issue 4242, destroy 242, balance 4000 |
| Price oracle | `Oracle` + service `src/Oracle` | Commit a Merkle root of prices; anyone gets proofs; attestation tokens for consumers | works: commitment confirmed, proof served |
| Decentralised exchange | `Dex` (ZenDex) | Make, take (partly or fully) and cancel orders between any two assets, no operator, no fees | make, take and cancel are confirmed; the take pays out to the taker's wallet |
| Bull/Bear bet on a price | `FixedPayout` | Issue Bull and Bear position tokens against collateral, redeem the winning side with an oracle proof | see [ORACLE.md](ORACLE.md); scenario in `scripts/testnet-bet.sh` |

## Where each can lead

- **Stable unit for the others.** A token named `zUSD` (NamedToken) or issued by one key (AuthenticatedSupply) gives a unit for collateral, prices and trades. On the testnet it is a plain test unit. There is no USDC on ZP and no bridge, so a real stable unit would mean a custodian or an over-collateralised design (see ORACLE.md, "Economics").
- **Markets.** ZenDex lists orders as outputs of the contract, so an order book is built by reading the chain (a page for it fits the explorer).
- **Derivatives.** FixedPayout is a binary option on an oracle price. Options on price, hedges and insurance are variations of it, written as new contracts.
- **Conditional payments.** Anything that pays when an oracle value passes a threshold uses the same attestation.

## Limits to know

- The oracle is one trusted party for the value; the chain proves when it was published and that it is unchanged.
- ZP has no market value now, so nothing here carries real money. Independent review of every contract and legal advice come first.
- FixedPayout accepts tickers of at most 4 characters, a value with 3 decimals and a fixed time window.
- The contracts take minutes to verify (F\*) the first time they are activated.

## Run it

Needs Docker and a testnet node with the public test wallet (see [TESTNET.md](TESTNET.md)); the CI workflow `testnet` runs all of it and prints the result of each scenario as a notice. By hand, from the repository: `scripts/testnet-contract.sh` (Token), `scripts/testnet-oracle.sh`, `scripts/testnet-bet.sh`, `scripts/testnet-instruments.sh`.

## Market maker (testnet)

`site/marketmaker/maker.mjs` keeps one sell-ZP and one buy-ZP order on the Dex around a reference price, so the order book is never empty. It runs as the `marketmaker` service of the testnet stack.

- Price: `MM_PRICE` (USD per ZP, default 0.10), or `MM_ORACLE=http://127.0.0.1:8085/<TICKER>` to take it from the latest oracle round.
- `MM_SPREAD_BPS` (100 = 1 % each side), `MM_REQUOTE_BPS` (50: cancel and re-make when the price moved this much), `MM_SIZE_ZP` (ZP per order), `MM_INTERVAL` seconds.
- It needs ZP and zUSDC in the node wallet (mining pays ZP; zUSDC comes from the bridge). Without funds it says so and waits.
- `MM_DRY=1` only prints what it would do.
- Orders it has open are read from the explorer API, so partial fills are handled: the remainder is what the Dex shows.
