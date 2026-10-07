# ZP Wallet

ZP Wallet is the community web wallet for the ZP network. It is non-custodial: recovery phrases and private keys are created, stored and used only in the user's browser. The server hosts static files, and the public node only ever sees addresses and already-signed transactions.

Live at `https://<site domain>/wallet/` (today `https://zen.sealinkgps.com/wallet/`). Source code: `wallet/`. License: MIT. It is a community project, not affiliated with Zen Protocol Ltd.

## What it does (version 0.1)

| Feature | Notes |
| --- | --- |
| Several wallets in one app | Each wallet has its own name and balance. A chip row switches between them, and the total across all wallets is shown. |
| Add a wallet | **New** (generates 24 words), **24 words** (restore any wallet for the ZP network, including the old desktop wallet), **Private key** (64 hex characters, or an extended key `xprv…` at the root or at account depth), **Watch** (one address: balance only, no spending). |
| Balance | Spendable balance, plus mining rewards that are still maturing (100 blocks) with the block at which they unlock. Contract tokens are listed separately. |
| Send | Checks the address and its network, offers Max, shows a review sheet, signs on the device and publishes the signed transaction. ZP has no network fee. Change goes back to the wallet's first receive address. |
| Receive | QR code and address. The first and last characters are highlighted so they can be checked with the sender. |
| Activity | Received, sent and mining-reward entries with confirmations. |
| CGP | Current interval, phase (before snapshot, nomination, voting) and time to the next phase, computed from the tip. The current block reward split comes from the node. |
| Node | Choose the node per network: the community node (default), any `https://` node, or `http://localhost:<port>` for your own. The connection is tested on save. |
| Mainnet / testnet | Each network keeps its own wallets. Testnet is marked in amber everywhere. There is no public testnet node yet: run one and enter its address. |
| Lock | A password unlocks the browser vault. The wallet locks itself after 15 minutes without activity, and "Lock now" is in Settings. |
| Backup | Shows the 24 words or key of a wallet after the password is entered again. |

Coming next (see `wallet/README.md`, plan steps 4, 5 and 7): voting from the wallet, running and deploying contracts, and other chains.

## Architecture

```
wallet/
  src/keys.js        BIP39 phrase -> BIP32 m/44'/258'/0' -> addresses (bech32 zen / tzn); private key import
  src/serialize.js   byte-exact port of src/Consensus/Serialization.fs (transactions, blocks)
  src/tx.js          coin selection, transaction building, secp256k1 signing, ZP amounts
  src/node.js        client for the node's public API (/node/ on the community site)
  src/vault.js       encrypted storage of secrets (WebCrypto)
  src/wallet.js      one wallet: address discovery, balances, history, prepare and publish a send
  web/               user interface: index.html, style.css, app.js (plain DOM, no framework)
  test/              unit tests, mock node, fixtures of real mainnet blocks
  build.mjs          bundles web/app.js and the libraries into dist/
```

Libraries: `@scure/bip39`, `@scure/bip32`, `@noble/curves`, `@noble/hashes`, `@scure/base` (all audited, no dependencies of their own) and `qrcode-generator`. The bundle is about 145 KB.

### Data flow

1. **Discovery**: for each wallet the app derives addresses on branches 0 (receive), 1 (change) and 2 (payment) in batches of 20, and asks `addressdb/discovery` which ones were used. It stops after 20 unused addresses in a row (gap limit).
2. **State**: `addressdb/outputs` (unspent outputs) and `blockchain/info` (tip). Coinbase outputs younger than 100 blocks are counted as maturing, not spendable.
3. **History**: `addressdb/transactions`.
4. **Send**: largest-first coin selection, outputs to the recipient and change, one PK witness per input signing the transaction hash (SHA3-256 of the transaction without witnesses), then `blockchain/publishtransaction` with the hex.

The node must run with the address index (`WALLET_API=1` or `PUBLIC_NODE=1`, see `docs/SETUP.md`). The community node exposes only a whitelist of read endpoints and `publishtransaction` through nginx. Port 11567 is never public.

## Security model

- **Secrets never leave the device.** The node receives addresses (public) and signed transactions only.
- **Vault**: a password-derived key (PBKDF2-SHA256, 600,000 iterations, random 16-byte salt) encrypts every secret with AES-256-GCM and a fresh 12-byte IV. Wallet records are kept in `localStorage` (`zp-wallet.vault.v1`); a secret is stored only as ciphertext. A wrong password is detected by an encrypted check value. Unlocked keys live in memory only and are dropped on lock.
- **No password recovery.** The password protects this browser only. The 24 words or the key are the real backup. "Forgot password" removes the wallets from the browser so they can be added again.
- **Content Security Policy**: scripts only from the wallet's own origin, no inline scripts or styles, no plugins, no forms posting elsewhere, no framing (`frame-ancestors 'none'`). Network access is limited to the same origin, `https:` nodes and localhost. The same policy is set as an HTTP header by nginx and as a meta tag in `index.html`.
- **No third-party code at runtime**: no CDN, analytics, fonts or trackers. Everything is bundled from pinned packages (`package-lock.json`).
- **Escaping**: every string from the user or a node is HTML-escaped before display. The test suite includes an injection check on wallet names.
- **Checks before signing**: the address must decode and belong to the selected network; contract addresses are refused for plain sends; amounts must balance; watch-only wallets cannot sign.
- **Same origin as the community page**: the wallet shares its origin with `index.html` and `stats.html`, which carry no third-party code. Do not add third-party scripts anywhere on the site.

What the wallet does not protect against: malware on the user's device, a browser extension with access to all pages, or a compromised web server serving changed files. Users who want independence from the server can build the wallet themselves (below) and open `dist/` from their own machine or host, connected to their own node.

## Compatibility with the network (tested)

| Part | Rule | Test |
| --- | --- | --- |
| Recovery phrase | BIP39, 24 words, no passphrase | `test/keys.test.js` |
| Keys | BIP32 secp256k1, account `m/44'/258'/0'` | same address as zen-node 1.0.13 for the CI test phrase |
| Address | bech32, hrp `zen` (mainnet) or `tzn` (testnet), version 0, SHA3-256 of the compressed public key | round trip |
| Serialization | port of `Serialization.fs` | 202 real mainnet transactions from 101 blocks re-serialize byte for byte |
| Transaction hash and signatures | SHA3-256 without witnesses; ECDSA secp256k1, RFC 6979, low-S, 64-byte compact | 473 mainnet signatures verify against our hashes |
| Send end to end | build, sign, publish | `test/wallet.test.js` against a mock node that checks every signature, key and amount |

The fixtures come from mainnet through the `fixtures` workflow (`scripts/fetch-tx-fixtures.py`).

## Build

Requires Node.js 22.

```
cd wallet
npm ci          # exact versions from package-lock.json
npm test        # 14 tests
npm run build   # writes dist/: index.html, style.css, app.js
```

CI (`.github/workflows/build.yml`, job `wallet`) runs the tests and the build on every push and uploads `dist/` as the `zp-wallet-web` artifact.

To try the UI locally against a fake node, start the mock node from `test/mocknode.js` (see the test files for how it is seeded), serve `dist/` from the same server or any static server, and set the node in Settings to `http://127.0.0.1:<port>/node`.

## Deploy

`site/setup-site.sh` builds and publishes the wallet together with the rest of the site:

1. It runs `npm ci && npm test && npm run build` in a throwaway `node:22-alpine` container, so the server needs Docker only.
2. If the tests and the build pass, it replaces `/var/www/zen/wallet/` with `dist/`. If they fail, the published wallet is left as it was.
3. nginx (`site/nginx-zen.conf`, `location /wallet/`) serves it with the security headers above.

Update after a code change:

```
cd ~/zenprotocol && git pull && sudo bash site/setup-site.sh
```

Check: `curl -sI https://<domain>/wallet/ | grep -i content-security` shows the policy.

Moving to another domain or server needs nothing extra: the wallet's default node is set in `src/node.js` (`DEFAULT_NODES`). When the domain changes, update it there and redeploy. Users can always change the node in Settings.

## Release checklist

1. `npm test` passes and CI is green.
2. Independent review of `src/tx.js`, `src/vault.js`, `src/keys.js` and `src/wallet.js` (signing, coin selection, encryption).
3. End-to-end on mainnet with a **fresh test wallet and a small amount**: receive, send to a second fresh wallet, check both balances and the transaction in a block. Never use a main wallet for testing, and never share a recovery phrase with anyone, including developers.
4. Deploy with `setup-site.sh` and check the headers.
