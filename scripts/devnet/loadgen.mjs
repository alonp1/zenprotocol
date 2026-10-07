#!/usr/bin/env node
// Load generator for a ZP devnet (docs/DEVNET.md). Signs real transactions with the wallet library and
// posts them to /blockchain/publishtransaction at a fixed rate, stepping up, and reports what the network
// really did: accepted per second, confirmed per second, transactions per block, publish latency, lag.
//
//   node scripts/devnet/loadgen.mjs --rates 5,20,50 --seconds 30
//   options: --node URL (default http://127.0.0.1:20000)  --nodes 20000,20001,20002 (ports to watch for lag)
//            --mnemonic "..." (default: the public devnet one)  --split 100 (outputs per splitting tx)
//            --out result.json
import fs from 'node:fs';
import { NodeClient } from '../../wallet/src/node.js';
import { openWallet, readState, receiveAddress } from '../../wallet/src/wallet.js';
import { buildTransaction } from '../../wallet/src/tx.js';
import { decodeAddress, deriveKey, encodeAddress } from '../../wallet/src/keys.js';
import { ZEN_ASSET, deserializeBlock } from '../../wallet/src/serialize.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const NODE = arg('node', 'http://127.0.0.1:20000');
const RATES = arg('rates', '5,20,50').split(',').map(Number);
const SECONDS = Number(arg('seconds', '30'));
const SPLIT = Number(arg('split', '100'));
const WATCH = arg('nodes', '20000,20001,20002').split(',');
const WORDS = arg('mnemonic', Array(23).fill('abandon').concat('art').join(' '));
const OUT = arg('out', '');
const UNIT = 1_000_000n, PAY = 1000n, CONCURRENCY = 64;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const node = new NodeClient(NODE, { timeoutMs: 60000 });
const w = openWallet({ id: 'dev', name: 'dev', network: 'test', kind: 'mnemonic' }, WORDS);
const me = receiveAddress(w);
const myHash = decodeAddress(me).hash;
const sink = encodeAddress(deriveKey(w.account, 0, 1).pkHash, 'test');
const sinkHash = decodeAddress(sink).hash;
const pk = h => ({ type: 'PK', hash: h });
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;

async function tip() { return (await node.info()).blocks; }
async function txsBetween(from, to) {          // transactions per block in (from, to]
  const per = [];
  for (let n = from + 1; n <= to; n += 200) {
    const upto = Math.min(to, n + 199);
    const blocks = await node.request(`/blockchain/blocks?blockNumber=${upto}&take=${upto - n + 1}`);
    for (const b of blocks) if (b.blockNumber > from && b.blockNumber <= to)
      per.push({ n: b.blockNumber, txs: deserializeBlock(Uint8Array.from(Buffer.from(b.rawBlock, 'hex')), { lenient: true }).txs.length - 1 }); // minus coinbase
  }
  return per.sort((a, b) => a.n - b.n);
}
async function mempoolSize() {
  try { const m = await node.request('/blockchain/mempool'); return Array.isArray(m) ? m.length : Object.keys(m || {}).length; } catch { return null; }
}
async function heights() {
  return Promise.all(WATCH.map(async p => { try { return (await new NodeClient(`http://127.0.0.1:${p}`).info()).blocks; } catch { return null; } }));
}
const mkTx = (u, payments, state) => buildTransaction({
  utxos: [{ ...u, key: [...w.keys.values()][0] }], payments, tipBlockNumber: state.tip, maturity: 10, changeLock: pk(myHash),
});
const own = u => u.lock.type === 'PK' ? u : null;

async function publishAll(txs, ratePerSec) {            // fire at a fixed rate, bounded concurrency
  const lat = [], errs = new Map(); let ok = 0, inflight = 0, i = 0;
  const t0 = Date.now(), tasks = [];
  while (i < txs.length) {
    const due = t0 + (i / ratePerSec) * 1000;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    while (inflight >= CONCURRENCY) await sleep(2);
    const t = txs[i++], s = Date.now(); inflight++;
    tasks.push(node.publish(t.hex).then(() => { ok++; lat.push(Date.now() - s); })
      .catch(e => { const k = String(e.message).slice(0, 80); errs.set(k, (errs.get(k) || 0) + 1); })
      .finally(() => { inflight--; }));
  }
  await Promise.all(tasks);
  return { ok, lat, errs: Object.fromEntries(errs), seconds: (Date.now() - t0) / 1000 };
}

// ---- 1. funds ---------------------------------------------------------------------------------
const need = RATES.reduce((a, r) => a + r * SECONDS, 0) + 50;
log(`devnet ${NODE}: wallet ${me}; need ${need} small outputs for rates ${RATES} x ${SECONDS}s`);
let state;
for (let i = 0; ; i++) {
  state = await readState(w, node);
  const small = state.utxos.filter(u => u.lock.type === 'PK' && u.spend.amount === UNIT).length;
  if (small >= need) break;
  const splitsNeeded = Math.ceil((need - small) / SPLIT);
  if (i > 400) throw new Error('funding did not complete; is the miner running?');
  const mature = state.utxos.filter(u => u.lock.type === 'Coinbase' && state.tip + 1 - u.lock.blockNumber >= 10);
  if (mature.length === 0) { log(`waiting for mature coinbase (tip ${state.tip})`); await sleep(5000); continue; }
  const batch = mature.slice(0, splitsNeeded);
  log(`splitting ${batch.length} coinbase outputs into ${SPLIT} x ${UNIT} each (have ${small}/${need})`);
  const txs = batch.map(u => mkTx(u, Array.from({ length: SPLIT }, () => ({ lock: pk(myHash), spend: { asset: ZEN_ASSET, amount: UNIT } })), state));
  const r = await publishAll(txs, 20);
  if (r.ok !== txs.length) log('split publish errors:', JSON.stringify(r.errs));
  await sleep(8000);
}
state = await readState(w, node);
const pool = state.utxos.filter(u => u.lock.type === 'PK' && u.spend.amount === UNIT);
log(`ready: ${pool.length} outputs of ${UNIT} kalapas, tip ${state.tip}`);

// ---- 2. steps ---------------------------------------------------------------------------------
const results = [];
let cursor = 0;
for (const rate of RATES) {
  const count = rate * SECONDS;
  log(`step ${rate} tx/s for ${SECONDS}s (${count} transactions, signing first)`);
  const txs = pool.slice(cursor, cursor + count).map(u => mkTx(u, [{ lock: pk(sinkHash), spend: { asset: ZEN_ASSET, amount: PAY } }], state));
  cursor += count;
  const startTip = await tip(), t0 = Date.now();
  const sent = await publishAll(txs, rate);
  let drained = null;
  for (let k = 0; k < 120; k++) { const m = await mempoolSize(); if (m === 0) { drained = (Date.now() - t0) / 1000; break; } if (m === null) break; await sleep(2000); }
  await sleep(3000);
  const endTip = await tip();
  const per = await txsBetween(startTip, endTip);
  const confirmed = per.reduce((a, b) => a + b.txs, 0);
  const elapsed = drained ?? (Date.now() - t0) / 1000;
  const hs = await heights();
  const row = {
    rate, seconds: SECONDS, sent: txs.length, accepted: sent.ok, rejected: txs.length - sent.ok, errors: sent.errs,
    acceptedPerSec: +(sent.ok / sent.seconds).toFixed(1), latencyMs: { p50: pct(sent.lat, .5), p95: pct(sent.lat, .95), max: pct(sent.lat, 1) },
    blocks: per.length, txsPerBlock: per.map(b => b.txs), confirmed, mempoolDrainedSec: drained,
    confirmedPerSec: +(confirmed / elapsed).toFixed(1), heights: hs, lagBlocks: hs.some(h => h === null) ? null : Math.max(...hs) - Math.min(...hs),
  };
  results.push(row);
  log(`  accepted ${row.accepted}/${row.sent} (${row.acceptedPerSec}/s), latency p50 ${row.latencyMs.p50} ms p95 ${row.latencyMs.p95} ms, confirmed ${confirmed} in ${per.length} blocks (${row.confirmedPerSec}/s), mempool drained ${drained ?? 'no'} s, heights ${hs}`);
  if (Object.keys(row.errors).length) log('  errors:', JSON.stringify(row.errors));
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ node: NODE, date: new Date().toISOString(), results }, null, 2));
console.log('\nrate  accepted/s  p50ms  p95ms  rejected  confirmed  confirmed/s  tx/block(max)  lag');
for (const r of results) console.log([r.rate, r.acceptedPerSec, r.latencyMs.p50, r.latencyMs.p95, r.rejected, r.confirmed, r.confirmedPerSec, Math.max(0, ...r.txsPerBlock), r.lagBlocks].map(x => String(x).padEnd(10)).join(''));
