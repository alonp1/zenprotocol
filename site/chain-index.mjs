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
// Repo voting contract: the community vote on protocol upgrades. Its command is the git commit id (40 hex) being voted for.
const REPO_CONTRACT_MAIN = '00000000e3113f8bf9cf8b764d945d6f99c642bdb069d137bdd5f7e44f1e75947f58a044';
const INTERVAL = 10000, SNAPSHOT = 9000, NOMINATION = 500;
const COMMUNITY_INTERVAL_OFFSET = 24;      // wallets and the explorer count intervals from the CGP launch
const CONFIRM = 10, TAKE = 2000;

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const NET = arg('net', process.env.ZEN_NET || 'main');   // 'main' or 'test': address prefix of the chain being indexed (zen / tzn)
const DEX_CONTRACT = arg('dex', process.env.ZEN_DEX || '');   // ZenDex contract id to index (testnet or mainnet); empty = off
const REPO_CONTRACT = arg('repo', process.env.ZEN_REPO ?? (NET === 'main' ? REPO_CONTRACT_MAIN : ''));   // empty = off
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
const contractAddress = cid => encodeAddress(unhex(cid), NET, true);
const pkAddress = pkHex => encodeAddress(pkHash(unhex(pkHex)), NET);

// ballot (Consensus/Serialization.fs Ballot): 1 = allocation byte; 2 = payout recipient + spends
function ballot(hexStr) {
  const r = new Reader(unhex(hexStr)), kind = r.u8();
  if (kind === 1) return { allocation: r.u8() };
  if (kind === 2) {
    const rk = r.u8();
    const recipient = rk === 1 ? encodeAddress(r.bytes(32), NET) : rk === 2 ? contractAddress(cidStr(ContractId.read(r))) : null;
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

const T0 = Date.now(), lap = what => console.log(`chain-index: timing ${what} at +${((Date.now() - T0) / 1000).toFixed(1)} s`);
const db = new DatabaseSync(DB);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=60000;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS utxo (outpoint TEXT PRIMARY KEY, asset TEXT, address TEXT, amount TEXT);
CREATE INDEX IF NOT EXISTS utxo_asset ON utxo(asset);
CREATE TABLE IF NOT EXISTS assets (asset TEXT PRIMARY KEY, contract TEXT, minted TEXT DEFAULT '0', destroyed TEXT DEFAULT '0',
                                   txs INTEGER DEFAULT 0, first_block INTEGER);
CREATE TABLE IF NOT EXISTS votes (tx TEXT, block INTEGER, time INTEGER, command TEXT, pk TEXT, ballot TEXT, PRIMARY KEY (tx, pk, command));
CREATE TABLE IF NOT EXISTS vweights (block INTEGER, pk TEXT, zp TEXT, PRIMARY KEY (block, pk));
CREATE TABLE IF NOT EXISTS commitvotes (tx TEXT, block INTEGER, time INTEGER, commit_id TEXT, pk TEXT, PRIMARY KEY (tx, pk));
CREATE TABLE IF NOT EXISTS payouts (tx TEXT, block INTEGER, time INTEGER, recipient TEXT, asset TEXT, amount TEXT);
CREATE TABLE IF NOT EXISTS dex (tx TEXT, block INTEGER, time INTEGER, command TEXT, under_asset TEXT, under_amount TEXT, pair_asset TEXT,
                                pair_total TEXT, maker TEXT, order_asset TEXT, payout TEXT, provided TEXT, PRIMARY KEY (tx, command));
CREATE TABLE IF NOT EXISTS allocation (interval INTEGER PRIMARY KEY, pct INTEGER, block INTEGER);
CREATE TABLE IF NOT EXISTS weights (interval INTEGER, pk TEXT, zp TEXT, PRIMARY KEY (interval, pk));
CREATE TABLE IF NOT EXISTS blocks (number INTEGER PRIMARY KEY, hash TEXT, parent TEXT, time INTEGER, difficulty INTEGER,
                                   txs INTEGER, reward TEXT, fees TEXT, moved TEXT, miner TEXT);
CREATE INDEX IF NOT EXISTS blocks_hash ON blocks(hash);
CREATE TABLE IF NOT EXISTS txs (hash TEXT PRIMARY KEY, block INTEGER, idx INTEGER, inputs TEXT, outputs TEXT, contract TEXT, command TEXT);
CREATE INDEX IF NOT EXISTS txs_block ON txs(block);
CREATE INDEX IF NOT EXISTS blocks_time ON blocks(time);
CREATE INDEX IF NOT EXISTS blocks_ntx ON blocks(txs);
-- one row per (address, transaction): ZP received and sent by the address in that transaction (base units)
CREATE TABLE IF NOT EXISTS addr_txs (address TEXT, tx TEXT, block INTEGER, idx INTEGER, recv INTEGER, sent INTEGER, PRIMARY KEY (address, tx));
CREATE INDEX IF NOT EXISTS addr_txs_block ON addr_txs(address, block, idx);`);
// ZP in the outputs of a transaction (without the fee), for searching by amount; added after the first release of the index
if (!db.prepare("SELECT 1 FROM pragma_table_info('txs') WHERE name='zp'").get()) db.exec('ALTER TABLE txs ADD COLUMN zp INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS txs_zp ON txs(zp)');
lap('database opened and tables checked');
const q = {
  meta: db.prepare('SELECT v FROM meta WHERE k=?'), setMeta: db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)'),
  utxoGet: db.prepare('SELECT asset, address, amount FROM utxo WHERE outpoint=?'),
  blockPut: db.prepare('INSERT OR REPLACE INTO blocks VALUES (?,?,?,?,?,?,?,?,?,?)'),
  txPut: db.prepare('INSERT OR REPLACE INTO txs(hash, block, idx, inputs, outputs, contract, command, zp) VALUES (?,?,?,?,?,?,?,?)'),
  addrPut: db.prepare('INSERT OR IGNORE INTO addr_txs VALUES (?,?,?,?,?,?)'), utxoDel: db.prepare('DELETE FROM utxo WHERE outpoint=?'),
  utxoPut: db.prepare('INSERT OR REPLACE INTO utxo VALUES (?,?,?,?)'),
  assetNew: db.prepare('INSERT OR IGNORE INTO assets(asset, contract, first_block) VALUES (?,?,?)'),
  assetGet: db.prepare('SELECT minted, destroyed FROM assets WHERE asset=?'),
  assetMint: db.prepare('UPDATE assets SET minted=? WHERE asset=?'), assetBurn: db.prepare('UPDATE assets SET destroyed=? WHERE asset=?'),
  assetTx: db.prepare('UPDATE assets SET txs = txs + 1 WHERE asset=?'),
  vote: db.prepare('INSERT OR IGNORE INTO votes VALUES (?,?,?,?,?,?)'),
  dexPut: db.prepare('INSERT OR REPLACE INTO dex VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
  cvote: db.prepare('INSERT OR IGNORE INTO commitvotes VALUES (?,?,?,?,?)'),
  payout: db.prepare('INSERT INTO payouts VALUES (?,?,?,?,?,?)'),
  allocHas: db.prepare('SELECT 1 FROM allocation WHERE interval=?'), allocPut: db.prepare('INSERT INTO allocation VALUES (?,?,?)'),
};
const meta = (k, d) => q.meta.get(k)?.v ?? d;

function addressOf(lock) {
  if (lock.type === 'PK') return encodeAddress(lock.hash, NET);
  if (lock.type === 'Coinbase') return encodeAddress(lock.pkHash, NET);
  if (lock.type === 'Contract') return contractAddress(cidStr(lock.contractId));
  return null;
}

// rows [address|kind, asset, amount] -> ZP total of real outputs, and per address ZP received / sent
const isAddr = a => typeof a === 'string' && /^c?(zen|tzn)1/.test(a);
function txFigures(ins, outs) {
  let zp = 0, by = new Map();
  const get = a => by.get(a) || by.set(a, { recv: 0, sent: 0 }).get(a);
  for (const [a, asset, amount] of outs) {
    if (asset === '00' && a !== 'Fee') zp += Number(amount);
    if (isAddr(a)) get(a).recv += asset === '00' ? Number(amount) : 0;
  }
  for (const [a, asset, amount] of ins) if (isAddr(a)) get(a).sent += asset === '00' ? Number(amount) : 0;
  return { zp, by };
}

// a vote on the Repo contract. Message body: [commit id (String), Dict {public key hex -> Signature}]; the voters are those keys
// (the key that pays the transaction is not the voter)
function repoVote(tx, th, n, ts, w) {
  if (!REPO_CONTRACT || cidStr(w.contractId) !== REPO_CONTRACT || !/^[0-9a-f]{40}$/.test(w.command || '')) return;
  const body = w.messageBody, items = body?.t === 'List' ? body.v : body ? [body] : [];
  const pks = [];
  for (const d of items) if (d?.t === 'Dict') for (const [k, sig] of d.v) if (typeof k === 'string' && /^0[23][0-9a-f]{64}$/.test(k) && sig?.t === 'Signature') pks.push(k);
  for (const pk of pks) q.cvote.run(th, n, ts, w.command, pk);
}

function indexBlock(n, raw) {
  const blk = deserializeBlock(unhex(raw), { lenient: true });
  for (const w of blk.irregular) console.log(`chain-index: block ${n}: witness ${w.id} declares ${w.count} bytes, re-serializes to ${w.size} (read by its fields, not by its declared length)`);
  const dv = new DataView(blk.header.buffer, blk.header.byteOffset);
  if (dv.getUint32(36) !== n) throw new Error(`block ${n}: header says ${dv.getUint32(36)}`);
  const ts = Number(dv.getBigUint64(72));
  let reward = 0n, fees = 0n, moved = 0n, blockMiner = null;
  blk.txs.forEach(({ tx }, txIdx) => {
    const th = hex(txHash(tx)), touched = new Set(), ins = [], outs = [];
    const cws = tx.witnesses.filter(w => w.type === 'Contract');
    const mintContract = cws[0] ? cidStr(cws[0].contractId) : null;
    for (const inp of tx.inputs) {
      if (inp.type === 'outpoint') {
        const op = hex(inp.outpoint.txHash) + ':' + inp.outpoint.index, row = q.utxoGet.get(op);
        if (row) { touched.add(row.asset); q.utxoDel.run(op); ins.push([row.address, row.asset, row.amount]); }
        else ins.push([null, null, null, hex(inp.outpoint.txHash) + ':' + inp.outpoint.index]);
      } else {
        const a = assetStr(inp.spend.asset); touched.add(a);
        ins.push(['mint', a, String(inp.spend.amount)]);
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
      outs.push([addr || o.lock.type, a, String(o.spend.amount)]);
      if (a === '00') {
        if (o.lock.type === 'Fee') fees += o.spend.amount;
        else if (o.lock.type === 'Coinbase' || (txIdx === 0 && o.lock.type === 'Contract')) reward += o.spend.amount;
        else moved += o.spend.amount;
      }
      if (o.lock.type === 'Coinbase' && !blockMiner) blockMiner = addr;
    });
    const cw0 = tx.witnesses.find(w => w.type === 'Contract');
    const fig = txFigures(ins, outs);
    q.txPut.run(th, n, txIdx, JSON.stringify(ins), JSON.stringify(outs), tx.contract ? 'deploy' : cw0 ? cidStr(cw0.contractId) : null, cw0 ? cw0.command : null, fig.zp);
    for (const [a, v] of fig.by) q.addrPut.run(a, th, n, txIdx, v.recv, v.sent);
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
      repoVote(tx, th, n, ts, w);
      if (DEX_CONTRACT && cid === DEX_CONTRACT && ['Make', 'Take', 'Cancel'].includes(w.command) && w.messageBody?.t === 'Dict') {
        // the order is in the message body; the order asset is the 1-unit asset of the contract that the transaction locks to it
        const f = Object.fromEntries(w.messageBody.v.map(([k, d]) => [k, d.v]));
        const oa = outs.find(o => o[0] === contractAddress(DEX_CONTRACT) && o[2] === '1' && o[1].startsWith(DEX_CONTRACT))?.[1] ?? null;
        const str = x => x == null ? null : x instanceof Uint8Array ? hex(x) : typeof x === 'object' ? JSON.stringify(x, (_, v) => typeof v === 'bigint' ? String(v) : v) : String(x);
        // a partial Take leaves the rest of the order open: what is left of it is the order's amounts minus what was paid and taken
        let under = f.UnderlyingAmount, total = f.OrderTotal;
        const payout = f.RequestedPayout, provided = f.ProvidedAmount;
        if (w.command === 'Take' && payout != null && provided != null) { under = BigInt(under) - BigInt(payout); total = BigInt(total) - BigInt(provided); }
        q.dexPut.run(th, n, ts, w.command, str(f.UnderlyingAsset), str(under), str(f.PairAsset), str(total), str(f.MakerPubKey), oa, str(payout), str(provided));
      }
      if (cid === CGP_CONTRACT && w.command === 'Payout') {
        for (const o of tx.outputs) {
          if ((o.lock.type === 'PK' || o.lock.type === 'Contract') && !(o.lock.type === 'Contract' && cidStr(o.lock.contractId) === CGP_CONTRACT))
            q.payout.run(th, n, ts, addressOf(o.lock), assetStr(o.spend.asset), String(o.spend.amount));
        }
      }
    }
    for (const a of touched) { q.assetNew.run(a, a === '00' ? '' : a.slice(0, 72), n); q.assetTx.run(a); }
  });
  // fees go to the miner inside the coinbase: what the coinbase pays above the block subsidy
  const subsidy = n < 2 ? 0n : (50n * 100000000n) >> BigInt(Math.floor((n - 2) / 800000));
  if (reward > subsidy) fees += reward - subsidy;
  q.blockPut.run(n, hex(pkHash(blk.header)), hex(blk.header.slice(4, 36)), ts, dv.getUint32(80), blk.txs.length,
                 String(reward), String(fees), String(moved), blockMiner);
}

// ---- one-time backfill: address rows and ZP amounts for the transactions indexed before they existed -----------
// Resumable inside the time budget; new blocks are only indexed once it is done, so no block is skipped.
const start0 = Date.now();
let migrated = meta('addrmig', '') === 'done';
if (!migrated) {
  const sel = db.prepare('SELECT rowid AS rid, hash, block, idx, inputs, outputs FROM txs WHERE rowid > ? ORDER BY rowid LIMIT 5000');
  const upd = db.prepare('UPDATE txs SET zp=? WHERE hash=?');
  let cur = Number(meta('addrmig_cursor', '0')), rows;
  while (Date.now() - start0 < BUDGET * 0.8 && (rows = sel.all(cur)).length) {
    db.exec('BEGIN');
    for (const r of rows) {
      const f = txFigures(JSON.parse(r.inputs), JSON.parse(r.outputs));
      upd.run(f.zp, r.hash);
      for (const [a, v] of f.by) q.addrPut.run(a, r.hash, r.block, r.idx, v.recv, v.sent);
    }
    cur = rows.at(-1).rid;
    q.setMeta.run('addrmig_cursor', String(cur));
    db.exec('COMMIT');
  }
  migrated = sel.all(cur).length === 0;
  if (migrated) { q.setMeta.run('addrmig', 'done'); console.log('chain-index: address index and amounts backfilled'); }
  else console.log(`chain-index: backfilling the address index (row ${cur}), indexing continues when done`);
}

// ---- one-time backfill of the Repo votes of blocks indexed before they were collected (about a hundred blocks, one request each) --
if (REPO_CONTRACT && meta('repomig2', '') !== 'done') {
  if (meta('repomig2_started', '') === '') { db.exec('DELETE FROM commitvotes'); q.setMeta.run('repomig2_started', '1'); q.setMeta.run('repomig_cursor', '0'); }
  // resumable: the node answers slowly, so each run works for a short while from where the last one stopped
  const cursor = Number(meta('repomig_cursor', '0')), allowed = Math.min(BUDGET * 0.3, 100000);
  const todo = db.prepare("SELECT DISTINCT block FROM txs WHERE contract=? AND length(command)=40 AND block > ? ORDER BY block").all(REPO_CONTRACT, cursor).map(r => r.block);
  let ok = true, i = 0;
  while (i < todo.length) {
    if (Date.now() - start0 > allowed) { ok = false; break; }
    const from = todo[i]; let j = i;                       // one request for blocks close together (at most 300 blocks)
    while (j + 1 < todo.length && todo[j + 1] - from < 300) j++;
    const to = todo[j], want = new Set(todo.slice(i, j + 1));
    try {
      const got = (await api(`/blockchain/blocks?blockNumber=${to}&take=${to - from + 1}`, undefined, 120000, 2)).filter(x => want.has(x.blockNumber));
      if (got.length !== want.size) throw new Error(`got ${got.length} of ${want.size} blocks`);
      db.exec('BEGIN');
      for (const b of got) {
        const blk = deserializeBlock(unhex(b.rawBlock), { lenient: true }), ts = Number(new DataView(blk.header.buffer, blk.header.byteOffset).getBigUint64(72));
        for (const { tx } of blk.txs) for (const w of tx.witnesses.filter(x => x.type === 'Contract')) repoVote(tx, hex(txHash(tx)), b.blockNumber, ts, w);
      }
      q.setMeta.run('repomig_cursor', String(to));
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } console.log(`chain-index: repo votes of blocks ${from}-${to}: ${e.message} (next run retries)`); ok = false; break; }
    i = j + 1;
  }
  if (ok) { q.setMeta.run('repomig2', 'done'); console.log('chain-index: repo votes backfilled'); }
  else console.log(`chain-index: repo votes backfill continues from block ${meta('repomig_cursor', '0')}`);
}

// ---- index new blocks ------------------------------------------------------------------------
const tip = (await api('/blockchain/info')).blocks;
lap('node answered /blockchain/info');
let last = Number(meta('last', '0'));
const target = tip - CONFIRM, start = Date.now(), from = last;
while (migrated && last < target && Date.now() - start < BUDGET) {
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
    for (const b of blocks) {
      try { indexBlock(b.blockNumber, b.rawBlock); }
      catch (e) {   // say which block and where, and keep its bytes for analysis
        console.log(`chain-index: block ${b.blockNumber} cannot be read: ${e.message} at byte ${e.pos} of ${e.length}`);
        try { fs.writeFileSync(`/var/lib/zen-stats/bad-block-${b.blockNumber}.hex`, b.rawBlock); console.log(`chain-index: raw block saved to /var/lib/zen-stats/bad-block-${b.blockNumber}.hex`); } catch { /* read-only */ }
        if (b.rawBlock.length < 6000) console.log(`chain-index: raw ${b.rawBlock}`);
        throw e;
      }
    }
    q.setMeta.run('last', String(upto));
    db.exec('COMMIT');
    last = upto;
  } catch (e) { db.exec('ROLLBACK'); console.log(`chain-index: stopped in ${last + 1}-${upto}: ${e.stack}`); process.exitCode = 1; break; }
}
lap('new blocks indexed');
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
lap('vote weights and cgp history ready');
// average seconds per block over the last 500 indexed blocks (the page turns remaining blocks into time)
let blockSeconds = null;
{ const a = db.prepare('SELECT number, time FROM blocks ORDER BY number DESC LIMIT 1').get();
  const b = a && db.prepare('SELECT number, time FROM blocks WHERE number <= ? ORDER BY number DESC LIMIT 1').get(Math.max(1, a.number - 500));
  if (a && b && a.number > b.number && a.time > b.time) blockSeconds = Math.round((a.time - b.time) / 1000 / (a.number - b.number)); }
// ---- community-votes.json: votes on protocol upgrades (Repo contract), by semester and phase -----------------------------------
// Each semester has a Contestants phase and a Candidates phase. A phase is a window of 1,000 blocks: its Snapshot block is where the
// weights are measured, its Tally block closes it. Windows as shown by the official explorer.
const PHASE = 1000, SEMESTERS = [{ sem: 1, cont: 117000, cand: 129000 }, { sem: 2, cont: 223000, cand: 234000 }];   // 1st semester Contestants inferred from a vote at block 117,758
const issuanceZP = n => 20000000 + 50 * (n - 1);                     // ZP in existence at block n (first 800,000 blocks: 50 ZP per block, Chain.fs getCurrentZPIssuance)
if (REPO_CONTRACT) {
  const txs = new Map();
  for (const v of db.prepare('SELECT tx, block, time, commit_id, pk FROM commitvotes ORDER BY block, tx').all()) {
    const t = txs.get(v.tx) || { tx: v.tx, block: v.block, time: v.time, commit: v.commit_id, pks: [] }; txs.set(v.tx, t); t.pks.push(v.pk);
  }
  const phases = new Map(), stray = [];
  const phaseOf = b => { for (const { sem, cont, cand } of SEMESTERS) for (const [kind, snap] of [['contestants', cont], ['candidates', cand]]) if (b >= snap && b < snap + PHASE) return { sem, kind, snap }; return null; };
  for (const t of txs.values()) {
    const ph = phaseOf(t.block); if (!ph) { stray.push(t.block); continue; }
    const key = ph.sem + ph.kind, P = phases.get(key) || { ...ph, seen: new Set(), votes: [] }; phases.set(key, P);
    const fresh = t.pks.filter(pk => !P.seen.has(pk)); fresh.forEach(pk => P.seen.add(pk));       // the first vote of a key in a phase counts
    P.votes.push({ tx: t.tx, block: t.block, time: t.time, commit: t.commit, voters: t.pks.map(pkAddress), counted: fresh.length > 0, weight: null, _fresh: fresh, _all: t.pks });
  }
  if (stray.length) console.log(`chain-index: ${stray.length} community votes outside the known phases (blocks ${[...new Set(stray)].slice(0, 8).join(', ')})`);
  // weight of a key = its ZP balance at the Snapshot block of the phase; cached, and filled in over several runs when the node is slow
  const vwGet = db.prepare('SELECT zp FROM vweights WHERE block=? AND pk=?'), vwPut = db.prepare('INSERT OR REPLACE INTO vweights VALUES (?,?,?)');
  let missing = 0;
  const keyZp = async (snap, pk) => {
    let zp = vwGet.get(snap, pk)?.zp ?? null;
    if (zp === null && Date.now() - T0 < BUDGET * 0.85) {
      try {
        const bal = await api('/addressdb/balance', { addresses: [pkAddress(pk)], blockNumber: String(snap) }, 60000, 2);
        zp = String(bal.filter(x => x.asset === '00').reduce((t, x) => t + BigInt(x.balance), 0n)); vwPut.run(snap, pk, zp);
      } catch { zp = null; }
    }
    return zp === null ? null : BigInt(zp);
  };
  if (complete) for (const P of phases.values()) for (const v of P.votes) {
    let all = 0n, cnt = 0n, ok = true;
    for (const pk of v._all) { const z = await keyZp(P.snap, pk); if (z === null) { ok = false; continue; } all += z; if (v._fresh.includes(pk)) cnt += z; }
    v.weightAll = ok ? Number(all) / 1e8 : null; v.weight = ok ? Number(cnt) / 1e8 : null; if (!ok) missing++;
  }
  if (missing) console.log(`chain-index: ${missing} community vote weights still to fetch (next run continues)`);
  const r8 = x => Math.round(x * 1e8) / 1e8;
  const phOut = [...phases.values()].map(P => {
    const commits = new Map();
    for (const { _fresh, _all, ...v } of P.votes) {
      const c = commits.get(v.commit) || { commit: v.commit, voters: 0, weight: 0, weightAll: 0, ballots: 0 }; commits.set(v.commit, c); c.ballots++;
      c.weightAll += v.weightAll || 0; if (v.counted) { c.voters += _fresh.length; c.weight += v.weight || 0; } }
    const list = [...commits.values()].map(c => ({ ...c, weight: r8(c.weight), weightAll: r8(c.weightAll) })).sort((a, b) => b.weight - a.weight || b.voters - a.voters);
    const votes = P.votes.map(({ _fresh, _all, ...v }) => v).sort((a, b) => b.block - a.block);
    const threshold = P.kind === 'contestants' ? Math.floor(issuanceZP(P.snap) * 3 / 100) : null;
    return { semester: P.sem, kind: P.kind, snapshot: P.snap, tally: P.snap + PHASE, complete: tip >= P.snap + PHASE, threshold,
             totalVoted: r8(list.reduce((s, c) => s + c.weight, 0)), totalVotedAllBallots: r8(list.reduce((s, c) => s + c.weightAll, 0)),
             voters: P.seen.size, ballots: votes.length, winner: list[0]?.commit ?? null, winnerWeight: list[0]?.weight ?? 0,
             contestants: threshold == null ? null : list.filter(c => c.weight >= threshold).length, commits: list, votes };
  }).sort((a, b) => b.snapshot - a.snapshot);
  writeJson('community-votes.json', { updated: Date.now(), indexedTo: last, tip, complete, blockSeconds, contract: REPO_CONTRACT, phases: phOut });
}
writeJson('cgp-history.json', { updated: Date.now(), indexedTo: last, tip, complete, blockSeconds, intervals: out });

// ---- assets.json ------------------------------------------------------------------------------
// Assets change slowly and computing them reads every unspent output (about 45 s): every 30 minutes is enough, or at once when the file is missing
const assetsFresh = fs.existsSync(path.join(WEB, 'assets.json')) && Date.now() - Number(meta('assets_at', '0')) < 30 * 60000;
if (assetsFresh) console.log('chain-index: assets.json is recent, not recomputed');
else {
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
lap('assets computed');
writeJson('assets.json', { updated: Date.now(), indexedTo: last, tip, complete, assets: rows });
  q.setMeta.run('assets_at', String(Date.now()));
}

