import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockNode } from './mocknode.js';
import { NodeClient } from '../src/node.js';
import { openWallet, discover, readState, prepareSend, publish, receiveAddress, addresses } from '../src/wallet.js';
import { accountFromMnemonic, deriveKey, encodeAddress } from '../src/keys.js';
import { createVault, unlockVault, seal, open } from '../src/vault.js';
import { parseZP } from '../src/tx.js';
import { hex } from '../src/serialize.js';

const WORDS = Array(23).fill('abandon').concat('art').join(' ');
const acct = accountFromMnemonic(WORDS);
const addr = (b, i) => encodeAddress(deriveKey(acct, b, i).pkHash);
const OTHER = 'zen1qqfjjy6ewd4thlj7erqsp2575hnm9mqnlrpaze9z6aafa7camxzdqxkdj9s';
const txid = n => n.toString(16).padStart(64, '0');

test('discover, balances with maturing coinbase, send, publish', async () => {
  const mock = createMockNode({ tip: 1000, utxos: [
    { txHash: txid(1), index: 0, address: addr(0, 0), amount: parseZP('10') },
    { txHash: txid(2), index: 1, address: addr(1, 25), amount: parseZP('5') },       // change branch, beyond first gap batch
    { txHash: txid(3), index: 0, address: addr(0, 3), amount: parseZP('25'), coinbaseBlock: 950 }, // immature
  ] });
  const url = await mock.listen();
  try {
    const node = new NodeClient(url + '/node');
    const w = openWallet({ id: 'a', name: 'Main', network: 'main', kind: 'mnemonic' }, WORDS);
    await discover(w, node);
    // receive 0 and 3, change 0 not used; change 25 lies in the second batch of 20 -> not found (gap limit)
    assert.ok(addresses(w).includes(addr(0, 3)));
    const st = await readState(w, node);
    const zp = st.assets.find(a => a.asset === '00');
    assert.equal(zp.spendable, parseZP('10'));
    assert.equal(zp.maturing, parseZP('25'));
    assert.equal(zp.maturesAt, 1049);

    assert.throws(() => prepareSend(w, st, OTHER, parseZP('11')), /Not enough funds/);
    const p = prepareSend(w, st, addr(0, 7), parseZP('4'));
    const h = await publish(node, p);
    assert.equal(h, p.hash);
    const st2 = await readState(w, node);
    // change returned to receive address 0: 6 ZP there now, 4 ZP went to receive 7 (not yet discovered)
    assert.equal(st2.assets.find(a => a.asset === '00').spendable, parseZP('6'));
  } finally { await mock.close(); }
});

test('wrong network and watch-only are refused', async () => {
  const w = openWallet({ id: 'b', name: 'K', network: 'main', kind: 'mnemonic' }, WORDS);
  const st = { tip: 10, utxos: [] };
  const testAddr = encodeAddress(deriveKey(acct, 0, 0).pkHash, 'test');
  assert.throws(() => prepareSend(w, st, testAddr, 1n), /testnet address/);
  const watch = openWallet({ id: 'c', name: 'W', network: 'main', kind: 'watch', addresses: [OTHER] });
  assert.equal(receiveAddress(watch), OTHER);
  assert.throws(() => prepareSend(watch, st, OTHER, 1n), /watch-only/);
});

test('private key import gives the same address as the phrase', () => {
  const k = hex(deriveKey(acct, 0, 0).privateKey);
  const w = openWallet({ id: 'd', name: 'Key', network: 'main', kind: 'key' }, k);
  assert.equal(receiveAddress(w), addr(0, 0));
  const x = openWallet({ id: 'e', name: 'X', network: 'main', kind: 'key' }, acct.privateExtendedKey);
  assert.equal(receiveAddress(x), addr(0, 0));
});

test('vault: encrypts, unlocks with the right password only', async () => {
  const { vault, key } = await createVault('correct horse');
  const box = await seal(key, { words: WORDS });
  assert.ok(!JSON.stringify(box).includes('abandon'));
  const k2 = await unlockVault(vault, 'correct horse');
  assert.deepEqual(await open(k2, box), { words: WORDS });
  await assert.rejects(unlockVault(vault, 'wrong password'), /Wrong password/);
  await assert.rejects(createVault('short'), /at least 8/);
});
