# USDC bridge prototype (testnet only)

ZP has no value of its own, so markets and bets need a unit that has. This prototype shows how USDC (on an EVM chain such as Base) can be used on ZP as the token **zUSDC**, 1:1, in 6 decimals like USDC. It runs on the ZP testnet with the USDC of an EVM *test* network (Circle's faucet gives free test USDC on Base Sepolia and Ethereum Sepolia). Nothing here holds real money.

## How it works

| Step | EVM chain | ZP testnet |
|---|---|---|
| Link | The depositor signs `Link <evm address> to <zp address>` with the EVM key; `POST /link` | The bridge stores the pair |
| Deposit | Send USDC to the bridge's EVM address | After N confirmations the bridge calls `Issue` on the AuthenticatedSupply contract (only the bridge key can) and the zUSDC lands in the linked ZP address |
| Withdraw | The bridge sends USDC to the linked EVM address | The user sends zUSDC to the bridge's ZP address and calls `POST /withdraw {zpTx, evm}`; the bridge checks the transaction (payer must be the linked ZP address), calls `Destroy`, then pays out |
| Reserves | The bridge's USDC balance | zUSDC outstanding = issued − destroyed (`GET /status`) |

A deposit from an address that has not linked yet waits (it is kept in `pending.json`) and is issued as soon as the link arrives.

## Pieces

- `site/bridge/bridge.mjs`: the service (Node 22 + `ethers` for the EVM side). `BRIDGE_EVM=mock:<file>` replaces the EVM chain with a JSON list of deposits, which is how CI tests it.
- `src/ContractExamples/AuthenticatedSupply.fst`: the token contract; the bridge's public key (sign path `m/44'/258'/0'/3/0`) is the only key that may issue or destroy.
- `zen-oracle body ... returnAddress:p=<pkhash>`: builds the issue message with a chosen recipient (type `p`, a public key hash lock).
- CI: `scripts/testnet-bridge.sh` (workflow `testnet`) activates the contract, starts the bridge with a mock deposit, links, and checks that 25,000,000 units arrive.

## Run it against Base Sepolia

```bash
cd site/bridge && npm install
BRIDGE_NODE=http://127.0.0.1:31567 BRIDGE_CONTRACT=<ctzn1…> BRIDGE_ASSET=<contract id hex> \
BRIDGE_EVM=https://sepolia.base.org BRIDGE_EVM_KEY=<test key, never a real one> \
node bridge.mjs
```

The EVM test key needs a little test ETH for withdrawals. The default USDC address is Circle's Base Sepolia test USDC.

## What is and is not done

- Done and tested in CI: link, deposit, issue to a chosen address.
- Written but not yet tested end to end: withdrawal (needs the explorer index to read the paying transaction) and the real EVM connection.
- Custody: one key holds the reserves and the issuing key. The plan is to move both to a community vote (multi-signature) before any real use. Real money, regulation and an independent audit come before that.
- Needed next: a deposit/withdraw page on the site, proof-of-reserves page (EVM balance versus zUSDC outstanding), pause switch, limits per user.

## Trying it on Base Sepolia (test network, test keys only)
1. Make two keys: `node site/bridge/evm-tools.mjs newkey` twice (the bridge's key and a depositor's key).
2. Faucets (free): the depositor needs test USDC (faucet.circle.com, network Base Sepolia) and a little test ETH; the bridge key needs a little test ETH for the gas of withdrawals (any Base Sepolia ETH faucet).
3. In `testnet-stack.env` set `BRIDGE_EVM=https://sepolia.base.org` and `BRIDGE_EVM_KEY=<bridge private key>`, then recreate the `bridge` service. `/bridge/status` then shows `bridgeEvm` (the address to send USDC to).
4. Link: `node site/bridge/evm-tools.mjs link <depositor key> <your ZP address>` and POST the printed JSON to `/link`.
5. Send USDC: `node site/bridge/evm-tools.mjs send <depositor key> <bridge address> 5`. After the confirmations the bridge issues the zUSDC to the linked ZP address.
