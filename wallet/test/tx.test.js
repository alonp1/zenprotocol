import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountFromMnemonic, deriveKey } from '../src/keys.js';
import { buildTransaction, verifyDigest, parseZP, formatZP, ZP } from '../src/tx.js';
import { deserializeTx, txHash, unhex, hex } from '../src/serialize.js';

const acct = accountFromMnemonic(Array(23).fill('abandon').concat('art'));
const k0 = deriveKey(acct, 0, 0), k1 = deriveKey(acct, 1, 0);
const utxo = (n, amount, lock = { type: 'PK', hash: k0.pkHash }) =>
  ({ outpoint: { txHash: new Uint8Array(32).fill(n), index: n }, lock, spend: { asset: ZP, amount }, key: k0 });

test('send picks inputs, adds change, signs every input', () => {
  const r = buildTransaction({
    utxos: [utxo(1, parseZP('5')), utxo(2, parseZP('3')), utxo(3, parseZP('0.5'))],
    payments: [{ lock: { type: 'PK', hash: new Uint8Array(32).fill(9) }, spend: { asset: ZP, amount: parseZP('6.25') } }],
    changeLock: { type: 'PK', hash: k1.pkHash }, tipBlockNumber: 1000 });
  const tx = deserializeTx(unhex(r.hex));
  assert.equal(tx.inputs.length, 2);
  assert.equal(tx.outputs.length, 2);
  assert.equal(tx.outputs[1].spend.amount, parseZP('1.75'));
  assert.equal(tx.witnesses.length, 2);
  for (const w of tx.witnesses) assert.ok(verifyDigest(w.signature, txHash(tx), w.publicKey));
  assert.equal(r.hash, hex(txHash(tx)));
});

test('immature coinbase outputs are not spent', () => {
  const cb = utxo(4, parseZP('25'), { type: 'Coinbase', blockNumber: 950, pkHash: k0.pkHash });
  assert.throws(() => buildTransaction({ utxos: [cb], payments: [{ lock: { type: 'PK', hash: k1.pkHash }, spend: { asset: ZP, amount: 1n } }],
    changeLock: { type: 'PK', hash: k0.pkHash }, tipBlockNumber: 1000 }), /Not enough funds/);
  assert.ok(buildTransaction({ utxos: [cb], payments: [{ lock: { type: 'PK', hash: k1.pkHash }, spend: { asset: ZP, amount: 1n } }],
    changeLock: { type: 'PK', hash: k0.pkHash }, tipBlockNumber: 1049 }));
});

test('ZP amount parsing and formatting', () => {
  assert.equal(parseZP('1'), 100000000n);
  assert.equal(parseZP('0.00000001'), 1n);
  assert.throws(() => parseZP('1.123456789'));
  assert.equal(formatZP(99989_99999991n), '99,989.99999991');
});
