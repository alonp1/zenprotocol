// Read-only explorer API for the community site, over the chain index (site/chain-index.mjs).
// Listens on 127.0.0.1 only; nginx publishes it as /explorer/api/ with a rate limit.
//
//   GET /explorer/api/blocks?before=<n>&take=<1..100>   latest blocks (summary rows)
//   GET /explorer/api/block/<number|hash>               block summary + its transactions
//   GET /explorer/api/tx/<hash>                         one transaction
//   GET /explorer/api/contract/<contract id>           a contract: calls (count, first/last, per command, the latest 20), extensions and what it holds now
//   GET /explorer/api/search/<text>                     where a number, hash or address leads
//   GET /explorer/api/address/<address>?page=&take=&from=&to=&minZp=&maxZp=
//                                                       live balances (node address index) + the address's transactions
//   GET /explorer/api/find/blocks?from=&to=&minTxs=&maxTxs=&minZp=&maxZp=&miner=&order=&page=&take=
//   GET /explorer/api/find/txs?address=&from=&to=&minZp=&maxZp=&asset=&kind=&order=&page=&take=
//                                                       dates are YYYY-MM-DD (UTC), amounts are in ZP, order/kind: see below
//
// Blocks not indexed yet (the index fills from genesis) are read from the node directly; near
// the tip that is fast. Run by the zen-explorer service (setup-site.sh).
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { encodeAddress } from '../wallet/src/keys.js';

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const NODE = arg('api', 'http://127.0.0.1:11567'), PORT = Number(arg('port', 11580));
const DB = arg('db', '/var/lib/zen-stats/chain-index.sqlite');
const DEX = arg('dex', process.env.ZEN_DEX || '');
const HEX64 = /^[0-9a-f]{64}$/;

let db = null, q = null;
const ready = () => open() && q.mig.get()?.v === 'done';
function open() {
  if (db) return true;
  try {
    db = new DatabaseSync(DB, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000');
    q = {
      last: db.prepare("SELECT v FROM meta WHERE k='last'"),
      blocks: db.prepare('SELECT * FROM blocks WHERE number < ? ORDER BY number DESC LIMIT ?'),
      byNum: db.prepare('SELECT * FROM blocks WHERE number=?'), byHash: db.prepare('SELECT * FROM blocks WHERE hash=?'),
      txsOf: db.prepare('SELECT * FROM txs WHERE block=? ORDER BY idx'), tx: db.prepare('SELECT * FROM txs WHERE hash=?'),
      mig: db.prepare("SELECT v FROM meta WHERE k='addrmig'"), mig2: db.prepare("SELECT v FROM meta WHERE k='extmig'"),
      coinbase: db.prepare('SELECT outputs FROM txs WHERE block=? AND idx=0'),
    };
    return true;
  } catch { db = null; return false; }
}

async function node(path, timeout = 30000) {
  const r = await fetch(NODE + path, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error('node ' + r.status);
  return r.json();
}
let tipCache = { at: 0, tip: 0 };
async function tip() {
  if (Date.now() - tipCache.at > 20000) tipCache = { at: Date.now(), tip: (await node('/blockchain/info')).blocks };
  return tipCache.tip;
}

// The coinbase pays the miner (Coinbase lock) and the CGP fund (the only contract a coinbase may pay, Consensus/BlockConnection.fs
// Coinbase.check). `reward` is both; `minerReward` and `cgpReward` split it. Contract addresses start with "czen"/"ctzn".
const isContractAddr = a => typeof a === 'string' && (a.startsWith('czen') || a.startsWith('ctzn'));
function cgpOfOutputs(outs) {
  let cgp = 0n;
  for (const [addr, asset, amount] of outs || []) if (asset === '00' && isContractAddr(addr)) cgp += BigInt(amount);
  return cgp;
}
function blockRow(b) {
  let cgp = null;
  try { const row = q.coinbase.get(b.number); if (row) cgp = cgpOfOutputs(JSON.parse(row.outputs)); } catch {}
  const split = cgp == null ? {} : { cgpReward: String(cgp), minerReward: String(BigInt(b.reward) - cgp) };
  return { number: b.number, hash: b.hash, parent: b.parent, time: b.time, difficulty: b.difficulty, txs: b.txs,
    reward: b.reward, ...split, fees: b.fees, moved: b.moved, miner: b.miner };
}
const txRow = t => ({ hash: t.hash, block: t.block, index: t.idx, inputs: JSON.parse(t.inputs), outputs: JSON.parse(t.outputs),
  contract: t.contract, command: t.command });

// a block straight from the node (JSON form), in the same shape as the index
function fromNodeJson(j) {
  const h = j.header, txs = Object.entries(j.transactions || {});
  let reward = 0n, moved = 0n, miner = null, cgpReward = 0n;
  const subsidy = h.blockNumber < 2 ? 0n : (5000000000n >> BigInt(Math.floor((h.blockNumber - 2) / 800000)));
  const rows = txs.map(([hash, tx], idx) => {
    const outs = (tx.outputs || []).map(o => {
      const l = o.lock, kind = typeof l === 'string' ? l : Object.keys(l)[0], v = typeof l === 'string' ? null : l[kind];
      const addr = v && typeof v === 'object' ? v.address || null : null, amt = BigInt(o.spend.amount);
      if (o.spend.asset === '00') {
        if (idx === 0 && (kind === 'Coinbase' || kind === 'PK' || kind === 'Contract')) reward += amt;
        if (idx === 0 && kind === 'Contract') cgpReward += amt;
        else if (kind !== 'Fee') moved += amt;
      }
      if (idx === 0 && !miner && (kind === 'Coinbase' || kind === 'PK')) miner = addr;
      return [addr || kind, o.spend.asset, o.spend.amount];
    });
    const ins = (tx.inputs || []).map(i => i.outpoint ? [null, null, null, i.outpoint.txHash + ':' + i.outpoint.index]
      : ['mint', i.mint.asset, i.mint.amount]);
    const cw = (tx.witness || []).map(w => w.ContractWitness).find(Boolean);
    return { hash, block: h.blockNumber, index: idx, inputs: ins, outputs: outs, contract: tx.contract ? 'deploy' : cw?.contractId || null, command: cw?.command || null };
  });
  return {
    block: { number: h.blockNumber, hash: j.hash, parent: h.parent, time: h.timestamp, difficulty: h.difficulty, txs: rows.length,
             reward: String(reward), minerReward: String(reward - cgpReward), cgpReward: String(cgpReward),
             fees: String(reward > subsidy ? reward - subsidy : 0n), moved: String(moved), miner },
    transactions: rows, source: 'node',
  };
}


// blocks read from the node are kept for a while: a page load must not cost the (single threaded) node ten calls
const liveCache = new Map();
function liveBlock(n, t) {
  const hit = liveCache.get(n), ttl = t - n < 2 ? 15000 : 600000;
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = node('/blockchain/block?blockNumber=' + n).then(j => fromNodeJson(j).block);
  liveCache.set(n, { at: Date.now(), p });
  p.catch(() => liveCache.delete(n));
  if (liveCache.size > 300) liveCache.delete(liveCache.keys().next().value);
  return p;
}

// ---- search --------------------------------------------------------------------------------------
const bad = m => Object.assign(new Error(m), { status: 400 });
const ADDRESS = /^c?(zen|tzn)1[0-9a-z]{20,90}$/, ASSET = /^[0-9a-f]{8,144}$/;
const whole = (v, name) => { if (v == null || v === '') return undefined; if (!/^\d{1,15}$/.test(v)) throw bad(name + ' must be a whole number'); return Number(v); };
const zpUnits = (v, name) => { if (v == null || v === '') return undefined; if (!/^\d{1,10}(\.\d{1,8})?$/.test(v)) throw bad(name + ' must be an amount in ZP'); return Math.round(Number(v) * 1e8); };
const day = (v, name, end) => { if (!v) return undefined; if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) throw bad(name + ' must be a date YYYY-MM-DD'); return Date.parse(v + 'T00:00:00Z') + (end ? 86399999 : 0); };
const pick = (v, allowed, def) => { if (v == null || v === '') return def; if (!allowed.includes(v)) throw bad('unknown option ' + v); return v; };
const LIMIT = 100000;   // counts and offsets stop here

// a growing list of conditions: where.add('b.time >= ?', value) is skipped when value is undefined
function conditions() {
  const parts = [], params = [];
  return { add(sql, v) { if (v !== undefined) { parts.push(sql); params.push(v); } }, raw(sql) { parts.push(sql); },
           get sql() { return parts.length ? 'WHERE ' + parts.join(' AND ') : ''; }, params };
}
function paging(query) {
  const take = Math.min(100, Math.max(1, whole(query.get('take')) || 25)), page = Math.min(Math.floor(LIMIT / take), Math.max(1, whole(query.get('page')) || 1));
  return { take, page, offset: (page - 1) * take };
}
const total = (from, w) => { const c = db.prepare(`SELECT COUNT(*) c FROM (SELECT 1 ${from} ${w.sql} LIMIT ${LIMIT + 1})`).get(...w.params).c; return { total: Math.min(c, LIMIT), capped: c > LIMIT }; };

function findBlocks(query) {
  const w = conditions(), { take, page, offset } = paging(query);
  w.add('time >= ?', day(query.get('from'), 'from')); w.add('time <= ?', day(query.get('to'), 'to', true));
  w.add('txs >= ?', whole(query.get('minTxs'), 'minTxs')); w.add('txs <= ?', whole(query.get('maxTxs'), 'maxTxs'));
  w.add('CAST(moved AS INTEGER) >= ?', zpUnits(query.get('minZp'), 'minZp')); w.add('CAST(moved AS INTEGER) <= ?', zpUnits(query.get('maxZp'), 'maxZp'));
  const miner = query.get('miner'); if (miner) { if (!ADDRESS.test(miner)) throw bad('miner must be an address'); w.add('miner = ?', miner); }
  const order = { newest: 'number DESC', oldest: 'number ASC', txs: 'txs DESC, number DESC', zp: 'CAST(moved AS INTEGER) DESC, number DESC' }[pick(query.get('order'), ['newest', 'oldest', 'txs', 'zp'], 'newest')];
  const rows = db.prepare(`SELECT * FROM blocks ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...w.params, take, offset);
  return { ...total('FROM blocks', w), page, take, blocks: rows.map(blockRow) };
}

// kind: all | transfers (not block rewards) | rewards | contracts;  order: newest | oldest | largest
function findTxs(query, address) {
  const w = conditions(), { take, page, offset } = paging(query);
  address ??= query.get('address') || undefined;
  if (address && !ADDRESS.test(address)) throw bad('not an address');
  const from = address ? 'FROM addr_txs a JOIN txs t ON t.hash = a.tx JOIN blocks b ON b.number = a.block' : 'FROM txs t JOIN blocks b ON b.number = t.block';
  if (address) w.add('a.address = ?', address);
  w.add('b.time >= ?', day(query.get('from'), 'from')); w.add('b.time <= ?', day(query.get('to'), 'to', true));
  w.add('t.zp >= ?', zpUnits(query.get('minZp'), 'minZp')); w.add('t.zp <= ?', zpUnits(query.get('maxZp'), 'maxZp'));
  const asset = query.get('asset');
  if (asset && asset !== '00' && asset.toLowerCase() !== 'zp') { if (!ASSET.test(asset)) throw bad('asset must be an asset ID'); w.add('instr(t.outputs, ?) > 0', '"' + asset + '"'); }
  const kind = pick(query.get('kind'), ['all', 'transfers', 'rewards', 'contracts'], 'all');
  if (kind === 'transfers') w.raw('t.idx > 0'); else if (kind === 'rewards') w.raw('t.idx = 0'); else if (kind === 'contracts') w.raw('t.contract IS NOT NULL');
  const order = { newest: 't.block DESC, t.idx DESC', oldest: 't.block ASC, t.idx ASC', largest: 't.zp DESC, t.block DESC' }[pick(query.get('order'), ['newest', 'oldest', 'largest'], 'newest')];
  const rows = db.prepare(`SELECT t.hash, t.block, t.idx, t.zp, t.contract, t.command, b.time${address ? ', a.recv, a.sent' : ''} ${from} ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...w.params, take, offset);
  return { ...total(from, w), page, take, transactions: rows.map(r => ({ hash: r.hash, block: r.block, index: r.idx, time: r.time, zp: r.zp, contract: r.contract, command: r.command, ...(address ? { received: r.recv, sent: r.sent } : {}) })) };
}

const dexAddress = () => encodeAddress(Uint8Array.from(Buffer.from(DEX, 'hex')), arg('net', process.env.ZEN_NET || 'main'), true);
async function nodePost(path, body, timeout = 20000) {
  const r = await fetch(NODE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error('node ' + r.status);
  return r.json();
}
async function address(addr, query) {
  if (!ADDRESS.test(addr)) throw bad('not an address');
  const sum = db.prepare('SELECT COUNT(*) n, MIN(block) fb, MAX(block) lb, SUM(recv) r, SUM(sent) s FROM addr_txs WHERE address=?').get(addr);
  const timeOf = n => n == null ? null : q.byNum.get(n)?.time ?? null;
  let balances = null;   // live from the node's address index; the history comes from our index
  try { balances = (await nodePost('/addressdb/balance', { addresses: [addr] })).map(x => ({ asset: x.asset, amount: String(x.balance) })); } catch { /* node busy or not a known address */ }
  return { address: addr, balances, summary: { transactions: sum.n, firstBlock: sum.fb, firstTime: timeOf(sum.fb), lastBlock: sum.lb, lastTime: timeOf(sum.lb), receivedZp: sum.r ?? 0, sentZp: sum.s ?? 0 },
           ...findTxs(query, addr) };
}

async function handle(p, query) {
  const t = await tip();
  const indexed = open() ? Number(q.last.get()?.v || 0) : 0;
  let m;
  if (p === '/blocks') {
    const take = Math.min(100, Math.max(1, Number(query.get('take')) || 25));
    const before = Math.min(t + 1, Number(query.get('before')) || t + 1);
    const out = [];
    // newest blocks may not be indexed yet: read those from the node (cheap near the tip)
    for (let n = before - 1; n > indexed && out.length < take && n >= 1; n--) out.push(await liveBlock(n, t));
    if (out.length < take && db) out.push(...q.blocks.all(Math.min(before, indexed + 1), take - out.length).map(blockRow));
    return { tip: t, indexedTo: indexed, blocks: out };
  }
  if ((m = p.match(/^\/block\/(\d{1,9}|[0-9a-f]{64})$/))) {
    const key = m[1];
    const row = db && (HEX64.test(key) ? q.byHash.get(key) : q.byNum.get(Number(key)));
    if (row) return { tip: t, block: blockRow(row), transactions: q.txsOf.all(row.number).map(txRow), source: 'index' };
    if (!HEX64.test(key) && Number(key) >= 1 && Number(key) <= t)
      return { tip: t, ...fromNodeJson(await node('/blockchain/block?blockNumber=' + Number(key), 60000)) };
    if (HEX64.test(key)) {
      try { return { tip: t, ...fromNodeJson(await node('/blockchain/block?hash=' + key)) }; } catch { /* not a block hash */ }
    }
    return null;
  }
  if ((m = p.match(/^\/tx\/([0-9a-f]{64})$/))) {
    const row = db && q.tx.get(m[1]);
    return row ? { tip: t, transaction: txRow(row), block: blockRow(q.byNum.get(row.block)) } : null;
  }
  if ((m = p.match(/^\/contract\/([0-9a-f]{72})$/))) {
    if (!open()) throw Object.assign(new Error('index not ready'), { status: 503 });
    const id = m[1], timeOf = n => n == null ? null : q.byNum.get(n)?.time ?? null;
    // transactions whose first contract call is this contract (the index keeps one contract per transaction)
    const sum = db.prepare('SELECT COUNT(*) n, MIN(block) fb, MAX(block) lb FROM txs WHERE contract = ?').get(id);
    const commands = db.prepare('SELECT command, COUNT(*) n, MAX(block) lastBlock FROM txs WHERE contract = ? GROUP BY command ORDER BY n DESC LIMIT 20').all(id)
      .map(r => ({ command: r.command, count: r.n, lastBlock: r.lastBlock, lastTime: timeOf(r.lastBlock) }));
    const recent = db.prepare('SELECT t.hash, t.block, t.command, t.zp, b.time FROM txs t JOIN blocks b ON b.number = t.block WHERE t.contract = ? ORDER BY t.block DESC, t.idx DESC LIMIT 20').all(id)
      .map(r => ({ hash: r.hash, block: r.block, time: r.time, command: r.command, zp: r.zp }));
    let extensions = null;   // null until the indexer has created the table (it is created when the indexer next runs)
    try {
      const es = db.prepare('SELECT COUNT(*) n, MAX(block) lb FROM extensions WHERE contract = ?').get(id);
      const all = db.prepare('SELECT amount FROM extensions WHERE contract = ?').all(id);
      extensions = { count: es.n, totalKalapas: String(all.reduce((x, r) => x + BigInt(r.amount), 0n)), lastBlock: es.lb, lastTime: timeOf(es.lb),
        recent: db.prepare('SELECT tx, block, time, amount FROM extensions WHERE contract = ? ORDER BY block DESC, idx DESC LIMIT 10').all(id).map(r => ({ hash: r.tx, block: r.block, time: r.time, kalapas: r.amount })),
        complete: q.mig2.get()?.v === 'done' };
    } catch { /* no extensions table yet */ }
    // what the contract holds now: the unspent outputs locked to its address, per asset
    let holds = null;
    try {
      const address = encodeAddress(Uint8Array.from(Buffer.from(id, 'hex')), arg('net', process.env.ZEN_NET || 'main'), true), by = new Map();
      for (const r of db.prepare('SELECT asset, amount FROM utxo WHERE address = ?').all(address)) {
        const e = by.get(r.asset) || by.set(r.asset, { asset: r.asset, amount: 0n, outputs: 0 }).get(r.asset);
        e.amount += BigInt(r.amount); e.outputs++;
      }
      holds = { address, assets: [...by.values()].sort((x, y) => (x.asset !== '00') - (y.asset !== '00') || (y.amount > x.amount ? 1 : -1)).slice(0, 50).map(e => ({ asset: e.asset, amount: String(e.amount), outputs: e.outputs })), total: by.size };
    } catch { /* no utxo table yet */ }
    return { tip: t, indexedTo: indexed, contract: id, executions: sum.n, extensions, holds, firstBlock: sum.fb, firstTime: timeOf(sum.fb), lastBlock: sum.lb, lastTime: timeOf(sum.lb), commands, recent };
  }
  if ((m = p.match(/^\/address\/([0-9a-z]{10,120})$/))) {
    if (!ready()) throw Object.assign(new Error('the address index is being built'), { status: 503 });
    return { tip: t, indexedTo: indexed, ...(await address(m[1], query)) };
  }
  if (p === '/dex/orders' || p === '/dex/trades') {
    if (!open()) throw Object.assign(new Error('index not ready'), { status: 503 });
    if (!DEX) return { dex: null, orders: [], trades: [] };
    if (p === '/dex/trades') return { tip: t, trades: db.prepare("SELECT tx, block, time, command, under_asset, under_amount, pair_asset, pair_total, maker, payout, provided FROM dex ORDER BY block DESC, tx LIMIT 100").all() };
    // an order is open while its 1-unit order asset is still held by the contract
    const held = new Set((await nodePost('/addressdb/balance', { addresses: [dexAddress()] })).map(x => x.asset));
    const rows = db.prepare("SELECT * FROM dex WHERE order_asset IS NOT NULL ORDER BY block DESC").all();
    return { tip: t, dex: DEX, orders: rows.filter(r => held.has(r.order_asset)).map(r => ({ ...r, open: true })) };
  }
  if (p === '/find/blocks') { if (!open()) throw Object.assign(new Error('index not ready'), { status: 503 }); return { tip: t, indexedTo: indexed, ...findBlocks(query) }; }
  if (p === '/find/txs') {
    if (!ready()) throw Object.assign(new Error('the address index is being built'), { status: 503 });
    return { tip: t, indexedTo: indexed, ...findTxs(query) };
  }
  if ((m = p.match(/^\/search\/(.{1,100})$/))) {
    const s = decodeURIComponent(m[1]).trim().toLowerCase();
    if (/^\d{1,9}$/.test(s)) return { kind: 'block', id: s };
    if (HEX64.test(s)) {
      if (db && q.tx.get(s)) return { kind: 'tx', id: s };
      return { kind: 'block', id: s };
    }
    if (/^c?(zen|tzn)1[0-9a-z]{20,90}$/.test(s)) return { kind: 'address', id: s };
    return { kind: 'none' };
  }
  return undefined;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/^\/explorer\/api/, '');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method !== 'GET') { res.statusCode = 405; return res.end('{}'); }
  try {
    const out = await handle(p, u.searchParams);
    if (out === undefined) { res.statusCode = 404; return res.end('{"error":"unknown path"}'); }
    if (out === null) { res.statusCode = 404; return res.end('{"error":"not found"}'); }
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = e.status || 502; res.end(JSON.stringify({ error: e.status ? e.message : 'node busy, try again' }));
  }
}).listen(PORT, '127.0.0.1', () => console.log('explorer api on 127.0.0.1:' + PORT));
