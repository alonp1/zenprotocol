// Index the ZP chain for the community site: assets (tokens) and the CGP voting history.
//
// Reads raw blocks in batches from the local node (GET /blockchain/blocks) and decodes them with
// ZP Wallet's serializer (wallet/src/serialize.js, tested byte for byte against mainnet blocks).
// State lives in SQLite; each run adds new blocks, then writes two static files for the site:
//
//   assets.json       every asset: tokens outstanding, holders, transactions, issuing contract
//   cgp-history.json  every CGP interval: allocation in force and decided, ballots with voters and
//                     vote weight, payouts executed
//
// Blocks closer than CONFIRM to the tip are not indexed, so a reorg cannot leave stale rows.
// The first run starts at genesis (a few hours in --budget steps). Run by the zen-index timer:
//
//   node --experimental-sqlite site/chain-index.mjs [--api http://127.0.0.1:11567] [--web /var/www/zen] [--budget 270]
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserializeBlock, txHash, hex, unhex, Reader, VarInt, ContractId, Spend } from '../wallet/src/serialize.js';
import { encodeAddress, pkHash } from '../wallet/src/keys.js';

const CGP_CONTRACT = '00000000cdaa2a511cd2e1d07555b00314d1be40a649d3b6f419eb1e4e7a8e63240a36d1';     // Chain.fs cgpContractId
const VOTING_CONTRACT = '000000006ea5457ed23e3e13f31fe4cfd46c200587f2e4cc22df30ac77790f6d2c15cc12';  // Chain.fs votingContractId
const INTERVAL = 10000, SNAPSHOT = 9000, NOMINATION = 500;
const COMMUNITY_INTERVAL_OFFSET = 24;      // wallets and the explorer count intervals from the CGP launch
const CONFIRM = 10, TAKE = 2000;

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const API = arg('api', 'http://127.0.0.1:11567'), WEB = arg('web', '/var/www/zen');
const DB = arg('db', '/var/lib/zen-stats/chain-index.sqlite'), BUDGET = Number(arg('budget', 270)) * 1000;
const SPARSE = process.argv.includes('--test-sparse');     // tests: accept non-contiguous sample blocks
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(p, body, timeout = 180000, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(API + p, body === undefined ? { signal: AbortSignal.timeout(timeout) }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
      const t = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 100)}`);
      if (!t) throw new Error('empty answer');
      return JSON.parse(t);
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(5000 * (i + 1));
    }
  }
}

// ---- ids and addresses, in the node's string formats ---------------------------------------
const u32hex = v => (v >>> 0).toString(16).padStart(8, '0');
const cidStr = c => u32hex(c.version) + hex(c.hash);
const isZero = a => a.every(x => x === 0);
const assetStr = a => isZero(a.contract.hash) && isZero(a.subtype) && a.contract.version === 0 ? '00'
  : cidStr(a.contract) + (isZero(a.subtype) ? '' : hex(a.subtype));
const contractAddress = cid => encodeAddress(unhex(cid), 'main', true);
const pkAddress = pkHex => encodeAddress(pkHash(unhex(pkHex)), 'main');

// ballot (Consensus/Serialization.fs Ballot): 1 = allocation byte; 2 = payout recipient + spends
function ballot(hexStr) {
  const r = new Reader(unhex(hexStr)), kind = r.u8();
  if (kind === 1) return { allocation: r.u8() };
  if (kind === 2) {
    const rk = r.u8();
    const recipient = rk === 1 ? encodeAddress(r.bytes(32), 'main') : rk === 2 ? contractAddress(cidStr(ContractId.read(r))) : null;
    if (!recipient) throw new Error('recipient');
    const n = VarInt.read(r), spends = [];
    for (let i = 0; i < n; i++) { const s = Spend.read(r); spends.push([assetStr(s.asset), String(s.amount)]); }
    return { recipient, spends };
  }
  throw new Error('ballot');
}

// ---- database ----------------------------------------------------------------------------------
fs.mkdirSync(path.dirname(DB), { recursive: true });
const lockFile = DB + '.lock';
try {                                           // one run at a time
  const fd = fs.openSync(lockFile, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
} catch {
  // in a container this process is often PID 1, so a PID alone proves nothing: a lock older than a run is stale
  const age = Date.now() - fs.statSync(lockFile).mtimeMs;
  if (age < BUDGET + 10 * 60000) { console.log('chain-index: another run is in progress'); process.exit(0); }
  fs.writeFileSync(lockFile, String(process.pid));
}
process.on('exit', () => { try { fs.unlinkSync(lockFile); } catch { /* gone */ } });

const db = new DatabaseSync(DB);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=60000;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS utxo (outpoint TEXT PRIMARY KEY, asset TEXT, address TEXT, amount TEXT);
CREATE INDEX IF NOT EXISTS utxo_asset ON utxo(asset);
CREATE TABLE IF NOT EXISTS assets (asset TEXT PRIMARY KEY, contract TEXT, minted TEXT DEFAULT '0', destroyed TEXT DEFAULT '0',
                                   txs INTEGER DEFAULT 0, first_block INTEGER);
CREATE TABLE IF NOT EXISTS votes (tx TEXT, block INTEGER, time INTEGER, command TEXT, pk TEXT, ballot TEXT, PRIMARY KEY (tx, pk, command));
CREATE TABLE IF NOT EXISTS payouts (tx TEXT, block INTEGER, time INTEGER, recipient TEXT, asset TEXT, amount TEXT);
CREATE TABLE IF NOT EXISTS allocation (interval INTEGER PRIMARY KEY, pct INTEGER, block INTEGER);
CREATE TABLE IF NOT EXISTS weights (interval INTEGER, pk TEXT, zp TEXT, PRIMARY KEY (interval, pk));`);
const q = {
  meta: db.prepare('SELECT v FROM meta WHERE k=?'), setMeta: db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)'),
  utxoGet: db.prepare('SELECT asset FROM utxo WHERE outpoint=?'), utxoDel: db.prepare('DELETE FROM utxo WHERE outpoint=?'),
  utxoPut: db.prepare('INSERT OR REPLACE INTO utxo VALUES (?,?,?,?)'),
  assetNew: db.prepare('INSERT OR IGNORE INTO assets(asset, contract, first_block) VALUES (?,?,?)'),
  assetGet: db.prepare('SELECT minted, destroyed FROM assets WHERE asset=?'),
  assetMint: db.prepare('UPDATE assets SET minted=? WHERE asset=?'), assetBurn: db.prepare('UPDATE assets SET destroyed=? WHERE asset=?'),
  assetTx: db.prepare('UPDATE assets SET txs = txs + 1 WHERE asset=?'),
  vote: db.prepare('INSERT OR IGNORE INTO votes VALUES (?,?,?,?,?,?)'),
  payout: db.prepare('INSERT INTO payouts VALUES (?,?,?,?,?,?)'),
  allocHas: db.prepare('SELECT 1 FROM allocation WHERE interval=?'), allocPut: db.prepare('INSERT INTO allocation VALUES (?,?,?)'),
};
const meta = (k, d) => q.meta.get(k)?.v ?? d;

function addressOf(lock) {
  if (lock.type === 'PK') return encodeAddress(lock.hash, 'main');
  if (lock.type === 'Coinbase') return encodeAddress(lock.pkHash, 'main');
  if (lock.type === 'Contract') return contractAddress(cidStr(lock.contractId));
  return null;
}

function indexBlock(n, raw) {
  const blk = deserializeBlock(unhex(raw));
  const dv = new DataView(blk.header.buffer, blk.header.byteOffset);
  if (dv.getUint32(36) !== n) throw new Error(`block ${n}: header says ${dv.getUint32(36)}`);
  const ts = Number(dv.getBigUint64(72));
  for (const { tx } of blk.txs) {
    const th = hex(txHash(tx)), touched = new Set();
    const cws = tx.witnesses.filter(w => w.type === 'Contract');
    const mintContract = cws[0] ? cidStr(cws[0].contractId) : null;
    for (const inp of tx.inputs) {
      if (inp.type === 'outpoint') {
        const op = hex(inp.outpoint.txHash) + ':' + inp.outpoint.index, row = q.utxoGet.get(op);
        if (row) { touched.add(row.asset); q.utxoDel.run(op); }
      } else {
        const a = assetStr(inp.spend.asset); touched.add(a);
        q.assetNew.run(a, mintContract || a.slice(0, 72), n);
        q.assetMint.run(String(BigInt(q.assetGet.get(a).minted) + inp.spend.amount), a);
      }
    }
    let miner = 0n, cgp = 0n;
    tx.outputs.forEach((o, i) => {
      const a = assetStr(o.spend.asset); touched.add(a);
      if (o.lock.type === 'Coinbase' && a === '00') miner += o.spend.amount;
      if (o.lock.type === 'Contract' && a === '00' && cidStr(o.lock.contractId) === CGP_CONTRACT) cgp += o.spend.amount;
      if (o.lock.type === 'Destroy') {
        q.assetNew.run(a, a.slice(0, 72), n);
        q.assetBurn.run(String(BigInt(q.assetGet.get(a).destroyed) + o.spend.amount), a);
      }
      const addr = addressOf(o.lock);
      if (addr) q.utxoPut.run(th + ':' + i, a, addr, String(o.spend.amount));
    });
    // allocation in force: CGP share of the coinbase of the first block seen in each interval
    if (miner > 0n) {
      const iv = Math.floor((n - 1) / INTERVAL) + 1;
      if (!q.allocHas.get(iv)) q.allocPut.run(iv, Number((cgp * 100n + (miner + cgp) / 2n) / (miner + cgp)), n);
    }
    for (const w of cws) {
      const cid = cidStr(w.contractId);
      if (cid === VOTING_CONTRACT && ['Allocation', 'Payout', 'Nomination'].includes(w.command) && w.messageBody?.t === 'Dict') {
        const entries = w.messageBody.v;
        const b = entries.find(([k, d]) => k !== 'Signature' && d.t === 'String')?.[1].v ?? null;
        const sigs = entries.find(([k, d]) => k === 'Signature' && d.t === 'Dict')?.[1].v || [];
        for (const [pk] of sigs) q.vote.run(th, n, ts, w.command, pk, b);
      }
      if (cid === CGP_CONTRACT && w.command === 'Payout') {
        for (const o of tx.outputs) {
          if ((o.lock.type === 'PK' || o.lock.type === 'Contract') && !(o.lock.type === 'Contract' && cidStr(o.lock.contractId) === CGP_CONTRACT))
            q.payout.run(th, n, ts, addressOf(o.lock), assetStr(o.spend.asset), String(o.spend.amount));
        }
      }
    }
    for (const a of touched) { q.assetNew.run(a, a === '00' ? '' : a.slice(0, 72), n); q.assetTx.run(a); }
  }
}

// ---- index new blocks ------------------------------------------------------------------------
const tip = (await api('/blockchain/info')).blocks;
let last = Number(meta('last', '0'));
const target = tip - CONFIRM, start = Date.now(), from = last;
while (last < target && Date.now() - start < BUDGET) {
  const upto = Math.min(target, last + TAKE);
  let blocks;
  try {
    blocks = await api(`/blockchain/blocks?blockNumber=${upto}&take=${upto - last}`);
  } catch (e) { console.log(`chain-index: node did not return blocks ${last + 1}-${upto}: ${e.message} (next run retries)`); break; }
  blocks = blocks.filter(b => b.blockNumber > last && b.blockNumber <= upto).sort((x, y) => x.blockNumber - y.blockNumber);
  if (!SPARSE && (blocks.length !== upto - last || blocks.some((b, i) => b.blockNumber !== last + 1 + i))) {
    console.log(`chain-index: incomplete batch ${last + 1}-${upto} (${blocks.length} blocks), next run retries`); break;
  }
  db.exec('BEGIN');
  try {
    for (const b of blocks) indexBlock(b.blockNumber, b.rawBlock);
    q.setMeta.run('last', String(upto));
    db.exec('COMMIT');
    last = upto;
  } catch (e) { db.exec('ROLLBACK'); console.log(`chain-index: stopped in ${last + 1}-${upto}: ${e.stack}`); process.exitCode = 1; break; }
}
const secs = (Date.now() - start) / 1000;
console.log(`chain-index: block ${last} of ${tip} (${last >= target ? 'synced' : 'catching up'}, ${Math.round((last - from) / Math.max(1, secs))} blocks/s)`);
const complete = last >= target;

// ---- names ----------------------------------------------------------------------------------
const readNames = f => { try { return Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(here, f), 'utf8'))).filter(([k]) => !k.startsWith('_'))); } catch { return {}; } };
const contractNames = readNames('contract-names.json'), assetNames = readNames('asset-names.json');
const cname = cid => cid && (contractNames[cid] || contractNames[contractAddress(cid)]) || null;

// ---- vote weights: balance at the snapshot block (address index), cached ----------------------
const wGet = db.prepare('SELECT zp FROM weights WHERE interval=? AND pk=?'), wPut = db.prepare('INSERT OR REPLACE INTO weights VALUES (?,?,?)');
async function weight(iv, pk) {
  const row = wGet.get(iv, pk);
  if (row) return BigInt(row.zp);
  try {
    const bal = await api('/addressdb/balance', { addresses: [pkAddress(pk)], blockNumber: String((iv - 1) * INTERVAL + SNAPSHOT) }, 120000, 2);
    const zp = bal.filter(x => x.asset === '00').reduce((s, x) => s + BigInt(x.balance), 0n);
    wPut.run(iv, pk, String(zp)); return zp;
  } catch { return null; }
}

// ---- cgp-history.json -------------------------------------------------------------------------
const alloc = Object.fromEntries(db.prepare('SELECT interval, pct FROM allocation').all().map(r => [r.interval, r.pct]));
const intervals = new Map();
for (const v of db.prepare('SELECT tx, block, time, command, pk, ballot FROM votes ORDER BY block, tx').all()) {
  const iv = Math.floor((v.block - 1) / INTERVAL) + 1, snap = (iv - 1) * INTERVAL + SNAPSHOT, nomEnd = snap + NOMINATION;
  const inWindow = v.command === 'Nomination' ? v.block > snap && v.block <= nomEnd : v.block > nomEnd && v.block <= iv * INTERVAL;
  let dec = null; try { dec = v.ballot ? ballot(v.ballot) : null; } catch { /* undecodable */ }
  const it = intervals.get(iv) || { votes: [], seen: new Set() }; intervals.set(iv, it);
  const key = v.command + v.pk, counted = inWindow && !it.seen.has(key);   // only the first ballot of a key per type counts
  if (counted) it.seen.add(key);
  it.votes.push({ tx: v.tx, block: v.block, time: v.time, command: v.command, voter: pkAddress(v.pk), ballot: dec, counted, weight: null, _pk: v.pk, _iv: iv });
}
if (complete) {
  for (const it of intervals.values()) for (const v of it.votes) if (v.counted) {
    const w = await weight(v._iv, v._pk); v.weight = w === null ? null : Number(w) / 1e8;
  }
}
const payouts = new Map();
for (const p of db.prepare('SELECT tx, block, time, recipient, asset, amount FROM payouts ORDER BY block').all()) {
  const iv = Math.floor((p.block - 2) / INTERVAL) + 1;      // paid at the end of the interval that voted for it
  const list = payouts.get(iv) || []; payouts.set(iv, list);
  list.push({ tx: p.tx, block: p.block, time: p.time, recipient: p.recipient, recipientName: contractNames[p.recipient] || null,
              asset: p.asset, amount: p.asset === '00' ? Number(p.amount) / 1e8 : p.amount });
}
const current = Math.floor((tip - 1) / INTERVAL) + 1;
const first = Math.min(current, ...intervals.keys(), ...payouts.keys(), ...Object.keys(alloc).map(Number));
const out = [];
for (let iv = first; iv <= current; iv++) {
  const vs = (intervals.get(iv)?.votes || []).map(({ _pk, _iv, ...v }) => v);
  out.push({
    interval: iv, communityInterval: iv - COMMUNITY_INTERVAL_OFFSET,
    start: (iv - 1) * INTERVAL + 1, snapshot: (iv - 1) * INTERVAL + SNAPSHOT, nominationEnd: (iv - 1) * INTERVAL + SNAPSHOT + NOMINATION, end: iv * INTERVAL,
    complete: tip > iv * INTERVAL, allocationInForce: alloc[iv] ?? null, allocationDecided: alloc[iv + 1] ?? null,
    voters: new Set(vs.map(v => v.voter)).size,
    weightVoted: Math.round(vs.filter(v => v.counted).reduce((s, v) => s + (v.weight || 0), 0) * 1e8) / 1e8,
    votes: vs, payouts: payouts.get(iv) || [],
  });
}
out.reverse();
function writeJson(name, data) {
  fs.mkdirSync(WEB, { recursive: true });
  const tmp = path.join(WEB, name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, path.join(WEB, name));
}
writeJson('cgp-history.json', { updated: Date.now(), indexedTo: last, tip, complete, intervals: out });

// ---- assets.json ------------------------------------------------------------------------------
const outstanding = new Map(), holders = new Map();
for (const r of db.prepare('SELECT asset, address, amount FROM utxo').iterate()) {
  outstanding.set(r.asset, (outstanding.get(r.asset) || 0n) + BigInt(r.amount));
  (holders.get(r.asset) || holders.set(r.asset, new Set()).get(r.asset)).add(r.address);
}
const subtypeText = a => {
  if (a.length <= 72) return null;
  const b = unhex(a.slice(72)); let end = b.length; while (end && !b[end - 1]) end--;
  const s = b.slice(0, end);
  return s.length && s.every(c => c > 32 && c < 127) ? String.fromCharCode(...s) : null;
};
const rows = db.prepare('SELECT asset, contract, minted, destroyed, txs, first_block FROM assets').all().map(r => {
  const base = r.asset === '00' ? 'ZP' : assetNames[r.asset] || (cname(r.contract) ? cname(r.contract) + ' token' : null);
  const name = r.asset === '00' ? 'ZP' : [base, subtypeText(r.asset)].filter(Boolean).join(' ') || null;
  const cAddr = r.contract && r.contract.length === 72 ? contractAddress(r.contract) : null;
  return { asset: r.asset, name, contract: r.contract || null, contractAddress: cAddr, contractName: cname(r.contract),
           outstanding: Number(outstanding.get(r.asset) || 0n) / 1e8, minted: Number(BigInt(r.minted)) / 1e8,
           destroyed: Number(BigInt(r.destroyed)) / 1e8, holders: holders.get(r.asset)?.size || 0, txs: r.txs, firstBlock: r.first_block };
}).sort((x, y) => (x.asset !== '00') - (y.asset !== '00') || y.txs - x.txs);
writeJson('assets.json', { updated: Date.now(), indexedTo: last, tip, complete, assets: rows });
