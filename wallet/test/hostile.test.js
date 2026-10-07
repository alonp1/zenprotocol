// The node is not trusted: malformed or hostile answers must not reach the UI or a transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWallet, readState, readHistory, publish, checkInfo } from '../src/wallet.js';
import { accountFromMnemonic, deriveKey, encodeAddress, parsePrivateKey } from '../src/keys.js';
import { parseZP, formatZP } from '../src/tx.js';
import { Writer, Amount, hex } from '../src/serialize.js';

const WORDS = Array(23).fill('abandon').concat('art').join(' ');
const acct = accountFromMnemonic(WORDS);
const k0 = deriveKey(acct, 0, 0), h0 = hex(k0.pkHash), a0 = encodeAddress(k0.pkHash);
const T = n => n.toString(16).padStart(64, '0');
const fakeNode = (info, outs, hist = []) => ({ info: async () => info, outputs: async () => outs, history: async () => hist });
const w = openWallet({ id: 'x', name: 'X', network: 'main', kind: 'mnemonic' }, WORDS);

test('bad info is refused, wrong chain is refused', () => {
  assert.throws(() => checkInfo({ blocks: '<b>1</b>', chain: 'main' }, 'main'), /invalid/);
  assert.throws(() => checkInfo({ blocks: 5, chain: 'testnet' }, 'main'), /testnet, not mainnet/);
  assert.equal(checkInfo({ blocks: 5, chain: 'main' }, 'main').blocks, 5);
});

test('outputs: duplicates, contract locks, bad amounts and assets are dropped', async () => {
  const pk = { PK: { hash: h0, address: a0 } };
  const st = await readState(w, fakeNode({ blocks: 1000, chain: 'main' }, [
    { outpoint: { txHash: T(1), index: 0 }, lock: pk, spend: { asset: '00', amount: '100' } },
    { outpoint: { txHash: T(1), index: 0 }, lock: pk, spend: { asset: '00', amount: '100' } },          // duplicate
    { outpoint: { txHash: T(2), index: 0 }, lock: { Contract: {} }, spend: { asset: '00', amount: '7' } },
    { outpoint: { txHash: T(3), index: 0 }, lock: pk, spend: { asset: '00', amount: '-5' } },
    { outpoint: { txHash: T(4), index: 0 }, lock: pk, spend: { asset: '00', amount: '1.5' } },
    { outpoint: { txHash: T(5), index: 0 }, lock: pk, spend: { asset: '<img>', amount: '9' } },
    { outpoint: { txHash: 'zz', index: 0 }, lock: pk, spend: { asset: '00', amount: '9' } },
    { outpoint: { txHash: T(6), index: 0 }, lock: pk, spend: { asset: '00', amount: '99999999999999999999' } },
  ]));
  assert.equal(st.utxos.length, 1);
  assert.deepEqual(st.assets.map(a => [a.asset, a.spendable]), [['00', 100n]]);
});

test('history rows with bad fields are dropped', async () => {
  const rows = await readHistory(w, fakeNode(null, null, [
    { txHash: T(1), asset: '00', amount: '5', confirmations: 3, timestamp: 1 },
    { txHash: T(2), asset: '00', amount: '1.5', confirmations: 3 },
    { txHash: T(3), asset: '00', amount: '5', confirmations: '<b>x</b>' },
  ]));
  assert.equal(rows.length, 1);
});

test('publish refuses a different hash from the node', async () => {
  await assert.rejects(publish({ publish: async () => T(9) }, { hex: '00', hash: T(8) }), /different transaction hash/);
  assert.equal(await publish({ publish: async () => T(8) }, { hex: '00', hash: T(8) }), T(8));
});

test('amount bounds and formatting', () => {
  assert.throws(() => parseZP('1,5'), /Invalid amount/);
  assert.throws(() => parseZP('200000000000'), /too large/);
  assert.throws(() => Amount.write(new Writer(), 2n ** 64n + 5n), /out of range/);
  assert.equal(formatZP(-50000000n), '-0.5');
});

test('extended keys at an unsupported depth are refused', () => {
  const branch = acct.deriveChild(0);                     // m/44'/258'/0'/0, depth 4
  assert.throws(() => parsePrivateKey(branch.privateExtendedKey), /depth 4 is not supported/);
  const leaf = branch.deriveChild(0);                     // depth 5: one address
  assert.equal(hex(parsePrivateKey(leaf.privateExtendedKey).key.pkHash), h0);
});
