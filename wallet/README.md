# ZP web wallet (work in progress)

Non-custodial browser wallet for the ZP network. Keys are derived and kept in the browser; the wallet talks to a public node (`/node/` on the community site) only for balances and to broadcast signed transactions.

Built on audited libraries: `@scure/bip39`, `@scure/bip32`, `@noble/curves` (secp256k1), `@noble/hashes` (SHA3), `@scure/base` (bech32).

## Compatibility (verified)

| Part | Rule (from the node source) | Test |
| --- | --- | --- |
| Recovery phrase | BIP39, 24 words, no passphrase | `test/keys.test.js` |
| Keys | BIP32 secp256k1, account `m/44'/258'/0'`, receive `…/0/i`, change `…/1/i` | same address as zen-node 1.0.13 for the CI test phrase |
| Address | bech32, hrp `zen`, version 0, SHA3-256 of the compressed public key | round trip |

## Plan

1. Keys and addresses - done
2. Transaction serialization and signing, checked byte for byte against the node
3. Balance, history, send, receive through the public node
4. CGP voting (allocation and payout ballots)
5. UI, security review, release

```
npm install
npm test
```

Community project. Not affiliated with or endorsed by Zen Protocol Ltd.
