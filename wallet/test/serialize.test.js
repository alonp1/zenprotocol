import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { Witness, deserializeBlock, deserializeTx, serializeTx, txHash, hex, unhex, Writer, Reader, Amount, VarInt, Asset, ZEN_ASSET } from '../src/serialize.js';
import { verifyDigest } from '../src/tx.js';

const FIX = new URL('./fixtures/blocks.json', import.meta.url);

test('varint matches bitcoin serialize.h vectors', () => {
  const cases = [[0, '00'], [127, '7f'], [128, '8000'], [255, '807f'], [256, '8100'], [16383, 'fe7f'], [16384, 'ff00'], [16511, 'ff7f'], [65535, '82fe7f'], [4294967295, '8efefefe7f']];
  for (const [n, h] of cases) {
    const w = new Writer(); VarInt.write(w, n);
    assert.equal(hex(w.out()), h, `write ${n}`);
    assert.equal(VarInt.read(new Reader(unhex(h))), n, `read ${h}`);
  }
});

test('amount encoding round-trips across all size classes', () => {
  const xs = [0n, 1n, 999n, 1000n, 2500000000n, 250045213n, 123456789n, 100000000000000n, 12345678901n,
              2n ** 56n - 1n, 2n ** 56n, 2n ** 64n - 1n, 99999999n, 70000000000000000n, 1234567800000000000n];
  for (const x of xs) {
    const w = new Writer(); Amount.write(w, x);
    assert.equal(Amount.read(new Reader(w.out())), x, `amount ${x}`);
  }
});

test('ZP asset is one zero byte', () => {
  const w = new Writer(); Asset.write(w, ZEN_ASSET);
  assert.equal(hex(w.out()), '00');
});

test('mainnet blocks: every transaction re-serializes byte for byte, hashes and signatures check out', { skip: !existsSync(FIX) && 'no fixtures yet' }, () => {
  const { blocks } = JSON.parse(readFileSync(FIX, 'utf8'));
  let txs = 0, sigs = 0, contracts = 0;
  for (const { blockNumber, rawBlock } of blocks) {
    const bytes = unhex(rawBlock);
    const block = deserializeBlock(bytes);
    for (const { tx, raw } of block.txs) {
      assert.equal(hex(serializeTx(tx)), hex(raw), `block ${blockNumber}: serialization differs`);
      assert.deepEqual(deserializeTx(raw), tx);
      const digest = txHash(tx);
      for (const w of tx.witnesses) {
        if (w.type === 'PK' && w.sigHash === 'TxHash') {
          assert.ok(verifyDigest(w.signature, digest, w.publicKey), `block ${blockNumber}: signature`);
          sigs++;
        }
        if (w.type === 'Contract') contracts++;
      }
      txs++;
    }
  }
  console.log(`checked ${blocks.length} blocks, ${txs} transactions, ${sigs} signatures, ${contracts} contract witnesses`);
  assert.ok(txs > blocks.length, 'fixtures should contain non-coinbase transactions');
});

test('a witness longer than what it parses to: strict refuses, lenient (indexer) follows the declared length', () => {
  const w = new Writer();
  VarInt.write(w, 1); VarInt.write(w, 1 + 33 + 64 + 2);           // PK witness declaring 2 extra bytes
  w.u8(1); w.bytes(new Uint8Array(33).fill(2)); w.bytes(new Uint8Array(64).fill(3)); w.bytes(Uint8Array.from([9, 9]));
  w.u8(0x77);                                                    // the next item in the stream
  const bytes = w.out();
  assert.throws(() => Witness.read(new Reader(bytes)), /witness size/);
  const r = new Reader(bytes); r.lenient = true;
  const x = Witness.read(r);
  assert.equal(x.type, 'PK');
  assert.equal(r.u8(), 0x77);
  assert.deepEqual(r.irregular, [{ id: 1, count: 100, size: 98 }]);
});
