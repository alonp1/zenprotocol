# ZP Wallet (work in progress)

Non-custodial browser wallet for the ZP network. Keys are derived and kept in the browser; the wallet talks to a public node (`/node/` on the community site) only for balances and to broadcast signed transactions.

Built on audited libraries: `@scure/bip39`, `@scure/bip32`, `@noble/curves` (secp256k1), `@noble/hashes` (SHA3), `@scure/base` (bech32).

## Compatibility (verified)

| Part | Rule (from the node source) | Test |
| --- | --- | --- |
| Recovery phrase | BIP39, 24 words, no passphrase | `test/keys.test.js` |
| Keys | BIP32 secp256k1, account `m/44'/258'/0'`, receive `…/0/i`, change `…/1/i` | same address as zen-node 1.0.13 for the CI test phrase |
| Address | bech32, hrp `zen`, version 0, SHA3-256 of the compressed public key | round trip |
| Serialization | port of `src/Consensus/Serialization.fs` (VarInt, amount encoding, assets, locks, witnesses, contract data) | 202 real mainnet transactions from 101 blocks re-serialize byte for byte (`test/fixtures/blocks.json`) |
| Transaction hash | SHA3-256 of the transaction without witnesses | 473 mainnet signatures verify against our hashes |
| Signing | secp256k1 ECDSA, RFC6979, low-S, 64-byte compact; one `TxHash` PK witness per input; no fee output | `test/tx.test.js` |

## Plan

1. Keys and addresses - done
2. Transaction serialization and signing, checked byte for byte against mainnet - done
3. Balance, history, send, receive through the public node
4. CGP voting: contract witness to the voting contract, command `Allocation` / `Payout` / `Nomination`, message body `{<command>: hex(ballot), Signature: {pk: sig}}`, signatures over SHA3(hex(U32 interval) + hex(String phase) + hex(String ballot)) - see `src/Blockchain/Tally_VoteParser.fs`
5. Smart contracts: tokens issued by contracts (multi-asset balances), list of active contracts (`/contract/active`), execute a contract (command, message body, assets sent with it; the node runs the contract via `/blockchain/contract/execute`, the wallet checks and signs the result), deploy a contract (advanced)
6. UI, security review, release
7. Multi-chain: the same recovery phrase derives keys per network (BIP44 coin types: ZP 258, Bitcoin 0, Ethereum 60). Each network is a separate adapter (addresses, balance, build and sign, broadcast) with its own byte-for-byte tests against real transactions; Bitcoin and Ethereum use public APIs with a switchable provider. View-only first, sending after. Swaps are out of scope.

Code is organised per network from the start (`src/` today = the ZP adapter) so more networks plug in without a rewrite.

```
npm install
npm test
```

Community project. Not affiliated with or endorsed by Zen Protocol Ltd.
