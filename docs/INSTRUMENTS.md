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
