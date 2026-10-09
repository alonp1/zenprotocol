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

test('extending a contract pays code length x blocks to an ExtensionSacrifice output', async () => {
  const { prepareExtend, extendCost } = await import('../src/wallet.js');
  const { deserializeTx, unhex } = await import('../src/serialize.js');
  const w = openWallet({ id: 'x', name: 'X', network: 'main', kind: 'mnemonic' }, WORDS);
  const key = [...w.keys.values()][0];
  const utxos = [{ outpoint: { txHash: new Uint8Array(32).fill(7), index: 0 }, lock: { type: 'PK', hash: key.pkHash }, spend: { asset: '00', amount: parseZP('5') } }];
  const id = '000000006ea5457ed23e3e13f31fe4cfd46c200587f2e4cc22df30ac77790f6d2c15cc12', code = 'x'.repeat(4000);
  assert.equal(extendCost(code, 10000), 40_000_000n);
  const p = prepareExtend(w, { tip: 100, utxos }, id, code, 10000);
  const tx = deserializeTx(unhex(p.hex));
  const sac = tx.outputs.find(o => o.lock.type === 'ExtensionSacrifice');
  assert.equal(sac.spend.amount, 40_000_000n);
  assert.equal(Buffer.from(sac.lock.contractId.hash).toString('hex'), id.slice(8));
  assert.equal(tx.outputs.find(o => o.lock.type === 'PK').spend.amount, parseZP('5') - 40_000_000n);
  assert.throws(() => prepareExtend(w, { tip: 100, utxos }, id, code, 0), /number of blocks/);
  assert.throws(() => prepareExtend(w, { tip: 100, utxos }, id, code, 10 ** 9), /Not enough funds|number of blocks/);
  assert.throws(() => prepareExtend(w, { tip: 100, utxos: [] }, id, code, 5), /Not enough funds/);
});
