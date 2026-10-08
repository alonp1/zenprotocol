// End-to-end test of the chain index and the explorer API on 100 real mainnet blocks (wallet/test/fixtures/blocks.json):
//   node --test site/test/
// A mock node serves the blocks; chain-index.mjs indexes them (including the backfill of an older index);
// explorer-api.mjs is started and queried.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(new URL(import.meta.url).pathname);
const fixture = JSON.parse(fs.readFileSync(path.join(here, '../../wallet/test/fixtures/blocks.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-test-'));
const DB = path.join(dir, 'db.sqlite');
const PORT = 11590;
let mock, api;

// the mock node lives in this process, so the indexer must run without blocking the event loop
const run = async args => (await promisify(execFile)('node', ['--no-warnings', path.join(here, '../chain-index.mjs'), '--api', `http://127.0.0.1:${mock.address().port}`, '--web', dir, '--db', DB, '--test-sparse', '--budget', '60', ...args])).stdout;
const get = async p => { const r = await fetch(`http://127.0.0.1:${PORT}/explorer/api${p}`); return { status: r.status, body: await r.json() }; };

before(async () => {
  mock = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { req.resume(); return res.end(JSON.stringify([{ asset: '00', balance: 12345678900 }])); }
    if (req.url.startsWith('/blockchain/info')) return res.end(JSON.stringify({ blocks: fixture.tip }));
    if (req.url.startsWith('/blockchain/blocks')) return res.end(JSON.stringify(fixture.blocks));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const seed = new DatabaseSync(DB);                       // start just below the sample blocks
  seed.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT); INSERT INTO meta VALUES ('last','1049000')"); seed.close();
});
after(() => { api?.kill(); mock?.closeAllConnections(); mock?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('index the sample blocks', async () => {
  const out = await run([]);
  assert.match(out, /block \d+ of/);
  const db = new DatabaseSync(DB, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM blocks').get().c, fixture.blocks.length);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM addr_txs').get().c > 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM txs WHERE zp IS NULL').get().c, 0);
  db.close();
});

test('an index made before the address table existed is backfilled to the same result', async () => {
  const db = new DatabaseSync(DB);
  const before = db.prepare('SELECT COUNT(*) c, SUM(recv) r, SUM(sent) s FROM addr_txs').get();
  const zps = db.prepare('SELECT SUM(zp) z FROM txs').get().z;
  db.exec("DELETE FROM addr_txs; UPDATE txs SET zp = NULL; DELETE FROM meta WHERE k LIKE 'addrmig%'");
  db.close();
  assert.match(await run([]), /backfilled/);
  const d2 = new DatabaseSync(DB, { readOnly: true });
  assert.deepEqual({ ...d2.prepare('SELECT COUNT(*) c, SUM(recv) r, SUM(sent) s FROM addr_txs').get() }, { ...before });
  assert.equal(d2.prepare('SELECT SUM(zp) z FROM txs').get().z, zps);
  d2.close();
});

test('the Repo vote backfill runs, and community-votes.json is written', async () => {
  const REPO = '00000000e3113f8bf9cf8b764d945d6f99c642bdb069d137bdd5f7e44f1e75947f58a044';
  const db = new DatabaseSync(DB);
  db.exec(`INSERT OR IGNORE INTO txs (hash, block, idx, inputs, outputs, contract, command) VALUES ('${'ab'.repeat(32)}', ${fixture.blocks[5].blockNumber}, 1, '[]', '[]', '${REPO}', '${'cd'.repeat(20)}'); DELETE FROM meta WHERE k LIKE 'repomig%'`);
  db.close();
  assert.match(await run([]), /repo votes backfilled/);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'community-votes.json'), 'utf8'));
  assert.equal(j.contract, REPO);
  assert.deepEqual(j.phases, []);      // the sample blocks hold no vote on that contract
  const d = new DatabaseSync(DB); d.exec(`DELETE FROM txs WHERE hash = '${'ab'.repeat(32)}'`); d.close();
});

test('start the API', async () => {
  api = spawn('node', ['--no-warnings', path.join(here, '../explorer-api.mjs'), '--api', `http://127.0.0.1:${mock.address().port}`, '--port', String(PORT), '--db', DB], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await get('/find/blocks?take=1')).status === 200) return; } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 100)); }
  assert.fail('API did not start');
});

test('find blocks: order, counts, dates, amounts', async () => {
  const all = (await get('/find/blocks?order=oldest&take=100')).body;
  assert.equal(all.total, fixture.blocks.length);
  assert.deepEqual(all.blocks.map(b => b.number), [...all.blocks.map(b => b.number)].sort((a, b) => a - b));
  const mx = Math.max(...all.blocks.map(b => b.txs));
  const busy = (await get(`/find/blocks?minTxs=${mx}&take=100`)).body, rest = (await get(`/find/blocks?maxTxs=${mx - 1}&take=100`)).body;
  assert.ok(busy.blocks.length > 0 && busy.blocks.every(b => b.txs >= mx));
  assert.ok(rest.blocks.every(b => b.txs < mx));
  assert.equal(busy.total + rest.total, all.total);
  const t = all.blocks[50].time, d = new Date(t).toISOString().slice(0, 10);
  const oneDay = (await get(`/find/blocks?from=${d}&to=${d}&take=100`)).body;
  assert.ok(oneDay.blocks.length > 0 && oneDay.blocks.every(b => new Date(b.time).toISOString().slice(0, 10) === d));
  const big = (await get('/find/blocks?order=zp&take=3')).body.blocks;
  assert.ok(Number(big[0].moved) >= Number(big[1].moved) && Number(big[1].moved) >= Number(big[2].moved));
  const some = (await get(`/find/blocks?minZp=${Number(big[0].moved) / 1e8}`)).body;
  assert.ok(some.blocks.every(b => Number(b.moved) >= Number(big[0].moved)));
  const page2 = (await get('/find/blocks?order=oldest&take=10&page=2')).body;
  assert.equal(page2.blocks[0].number, all.blocks[10].number);
});

test('find transactions and the address page', async () => {
  const transfers = (await get('/find/txs?kind=transfers&take=100')).body;
  assert.ok(transfers.transactions.length > 0 && transfers.transactions.every(t => t.index > 0));
  const rewards = (await get('/find/txs?kind=rewards&take=100')).body;
  assert.ok(rewards.transactions.every(t => t.index === 0));
  const db = new DatabaseSync(DB, { readOnly: true });
  const a = db.prepare('SELECT address, COUNT(*) n FROM addr_txs GROUP BY address ORDER BY n DESC LIMIT 1').get(); db.close();
  const page = (await get(`/address/${a.address}`)).body;
  assert.equal(page.summary.transactions, a.n);
  assert.equal(page.transactions.length, Math.min(25, a.n));
  assert.deepEqual(page.balances, [{ asset: '00', amount: '12345678900' }]);
  const viaFind = (await get(`/find/txs?address=${a.address}&order=oldest&take=100`)).body;
  assert.equal(viaFind.total, a.n);
  assert.ok(viaFind.transactions[0].block <= viaFind.transactions.at(-1).block);
  const largest = (await get('/find/txs?order=largest&take=2')).body.transactions;
  assert.ok(largest[0].zp >= largest[1].zp);
  const min = (await get(`/find/txs?minZp=${largest[0].zp / 1e8}`)).body;
  assert.ok(min.transactions.every(t => t.zp >= largest[0].zp));
});

test('bad input is refused, not executed', async () => {
  for (const p of ['/find/blocks?from=yesterday', '/find/blocks?minTxs=-1', '/find/blocks?miner=abc', "/find/blocks?order=number;DROP TABLE blocks",
                   '/find/txs?minZp=1e9', "/find/txs?asset=ab' OR '1'='1", '/find/txs?kind=all;--', '/find/txs?address=notanaddress', '/address/zen1' + 'q'.repeat(5)]) {
    const r = await get(p);
    assert.ok(r.status === 400 || r.status === 404, `${p} -> ${r.status}`);
  }
  assert.equal((await get('/find/blocks?take=1')).status, 200);   // tables are intact
});
