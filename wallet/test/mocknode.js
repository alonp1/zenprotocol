// A small fake node for tests and UI development: the /node/ API shape with in-memory UTXOs.
// publishtransaction really checks the transaction: inputs exist and are unspent, each PK witness
// signs the tx hash with the key of the spent output, amounts balance. Then it applies it.
import http from 'node:http';
import { deserializeTx, txHash, hex, unhex, assetToString } from '../src/serialize.js';
import { decodeAddress, encodeAddress, pkHash } from '../src/keys.js';
import { verifyDigest } from '../src/tx.js';

export function createMockNode({ tip = 1053000, utxos = [], chain = 'main' } = {}) {
  // utxos: [{ txHash(hex), index, address, amount(BigInt), asset:'00', coinbaseBlock? }]
  const state = { tip, utxos: utxos.map(u => ({ ...u })), history: [], published: [] };
  const byAddr = a => state.utxos.filter(u => u.address === a);
  const lockJson = u => {
    const h = hex(decodeAddress(u.address).hash);
    return u.coinbaseBlock ? { Coinbase: { blockNumber: u.coinbaseBlock, pkHash: h, address: u.address } }
                           : { PK: { hash: h, address: u.address } };
  };

  const routes = {
    'GET /blockchain/info': () => ({ chain, blocks: state.tip, headers: state.tip, difficulty: 1000, medianTime: Date.now(), initialBlockDownload: false, tip: '00'.repeat(32) }),
    'POST /addressdb/discovery': b => b.addresses.map(a => ({ address: a, hasBalance: byAddr(a).length > 0, hasTxs: byAddr(a).length > 0 || state.history.some(h => h.address === a) })),
    'POST /addressdb/outputs': b => b.addresses.flatMap(a => byAddr(a).map(u => ({ outpoint: { txHash: u.txHash, index: u.index }, lock: lockJson(u), spend: { asset: u.asset || '00', amount: String(u.amount) } }))),
    'POST /addressdb/balance': b => {
      const m = new Map();
      for (const a of b.addresses) for (const u of byAddr(a)) m.set(u.asset || '00', (m.get(u.asset || '00') || 0n) + u.amount);
      return [...m].map(([asset, balance]) => ({ asset, balance: Number(balance) }));
    },
    'POST /addressdb/transactions': b => state.history.filter(h => b.addresses.includes(h.address)).slice(b.skip, b.skip + b.take),
    'POST /blockchain/publishtransaction': b => {
      const tx = deserializeTx(unhex(b.tx));
      const digest = txHash(tx);
      if (tx.witnesses.length !== tx.inputs.length) throw new Error('witness count');
      let inSum = 0n;
      tx.inputs.forEach((inp, i) => {
        const u = state.utxos.find(x => x.txHash === hex(inp.outpoint.txHash) && x.index === inp.outpoint.index);
        if (!u) throw new Error('input not found or spent');
        if (u.coinbaseBlock && state.tip + 1 - u.coinbaseBlock < 100) throw new Error('immature coinbase');
        const w = tx.witnesses[i];
        if (hex(pkHash(w.publicKey)) !== hex(decodeAddress(u.address).hash)) throw new Error('wrong key');
        if (!verifyDigest(w.signature, digest, w.publicKey)) throw new Error('bad signature');
        inSum += u.amount;
      });
      const outSum = tx.outputs.reduce((s, o) => s + o.spend.amount, 0n);
      if (outSum !== inSum) throw new Error(`amounts do not balance ${inSum} != ${outSum}`);
      const h = hex(digest);
      for (const inp of tx.inputs) state.utxos = state.utxos.filter(x => !(x.txHash === hex(inp.outpoint.txHash) && x.index === inp.outpoint.index));
      tx.outputs.forEach((o, i) => {
        const address = encodeAddress(o.lock.hash, chain);
        state.utxos.push({ txHash: h, index: i, address, amount: o.spend.amount, asset: assetToString(o.spend.asset) });
        state.history.unshift({ txHash: h, asset: '00', amount: String(o.spend.amount), confirmations: 0, timestamp: Date.now(), lock: { PK: { hash: hex(o.lock.hash), address } }, address });
      });
      state.published.push(b.tx);
      return h;
    },
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.writeHead(202); return res.end(); }
      const path = req.url.replace(/^\/node/, '').split('?')[0];
      const fn = routes[`${req.method} ${path}`];
      if (!fn) { res.writeHead(404); return res.end('not found'); }
      try {
        const out = fn(body ? JSON.parse(body) : undefined);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? v.toString() : v));
      } catch (e) { res.writeHead(400); res.end(e.message); }
    });
  });
  return { server, state,
    listen: (port = 0) => new Promise(r => server.listen(port, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise(r => server.close(r)) };
}
