// USDC bridge prototype (testnet only, custodial): USDC on an EVM chain <-> zUSDC on ZP.
//   deposit:   USDC sent to the bridge's EVM address by a linked EVM address -> zUSDC issued (AuthenticatedSupply Issue) to its ZP address
//   withdraw:  user sends zUSDC to the bridge's ZP address and posts the transaction -> the bridge destroys it and sends USDC
// Amounts are in USDC base units (6 decimals) on both sides, 1:1. See docs/BRIDGE.md.
//
// Environment (all optional but the contract):
//   BRIDGE_NODE      ZP node API            (http://127.0.0.1:31567)
//   BRIDGE_CONTRACT  AuthenticatedSupply address (ctzn1...)   BRIDGE_ASSET  its asset id (contract id hex, default asset)
//   BRIDGE_PASSWORD  wallet password (testnet)    BRIDGE_SIGN  sign path (m/44'/258'/0'/3/0)
//   BRIDGE_EVM       rpc URL, or  mock:<file>  (a JSON list of {tx, log, from, to, amount, block} for tests)
//   BRIDGE_USDC      USDC token address on that chain      BRIDGE_EVM_KEY  private key of the bridge's EVM wallet (for withdrawals)
//   BRIDGE_CONFIRMATIONS (12)   BRIDGE_DATA (./data)   BRIDGE_LISTEN (127.0.0.1:8090)   BRIDGE_INTERVAL (15 s)
//   BRIDGE_ZO        command that runs zen-oracle (dotnet src/Oracle/bin/Release/zen-oracle.dll)
//   BRIDGE_EXPLORER  explorer API for reading withdrawal transactions (http://127.0.0.1:11580/explorer/api)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decodeAddress } from '../../wallet/src/keys.js';

const env = (k, d) => process.env[k] ?? d;
const NODE = env('BRIDGE_NODE', 'http://127.0.0.1:31567'), CONTRACT = env('BRIDGE_CONTRACT', ''), ASSET = env('BRIDGE_ASSET', '');
const PW = env('BRIDGE_PASSWORD', 'testnet'), SIGN = env('BRIDGE_SIGN', "m/44'/258'/0'/3/0");
const EVM = env('BRIDGE_EVM', 'mock:./data/evm.json'), USDC = env('BRIDGE_USDC', '0x036CbD53842c5426634e7929541eC2318f3dCF7e');   // Base Sepolia test USDC
const CONF = Number(env('BRIDGE_CONFIRMATIONS', '12')), DATA = env('BRIDGE_DATA', './data');
const [HOST, PORT] = env('BRIDGE_LISTEN', '127.0.0.1:8090').split(':');
const ZO = env('BRIDGE_ZO', 'dotnet src/Oracle/bin/Release/zen-oracle.dll').split(' ');
const EXPLORER = env('BRIDGE_EXPLORER', 'http://127.0.0.1:11580/explorer/api');
const INTERVAL = Number(env('BRIDGE_INTERVAL', '15')) * 1000;

fs.mkdirSync(DATA, { recursive: true });
const file = n => path.join(DATA, n);
const load = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
const save = (n, v) => { fs.writeFileSync(file(n) + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(file(n) + '.tmp', file(n)); };
let links = load('links.json', {});        // evm address (lower case) -> { zp, since }
let done = load('done.json', {});          // "<evmtx>:<log>" -> { zp tx, amount }   and  "w:<zptx>" -> { evm tx }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- ZP side ----------------------------------------------------------------------------------
async function zp(pathname, body) {
  const r = await fetch(NODE + pathname, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}
const pkHashHex = addr => Buffer.from(decodeAddress(addr).hash).toString('hex');
const body = specs => execFileSync(ZO[0], [...ZO.slice(1), 'body', ...specs], { encoding: 'utf8' }).trim();
async function execute(command, specs, spends) {
  const r = await zp('/wallet/contract/execute', { address: CONTRACT, command, messageBody: body(specs), options: { sign: SIGN }, spends, password: PW });
  if (typeof r !== 'string' || !/^"?[0-9a-f]{64}"?$/.test(r.trim())) throw new Error('execute ' + command + ': ' + JSON.stringify(r).slice(0, 200));
  return r.replace(/"/g, '').trim();
}
const issue = (zpAddr, amount) => execute('Issue', [`Amount:u=${amount}`, `returnAddress:p=${pkHashHex(zpAddr)}`], []);
const destroy = amount => execute('Destroy', [`Amount:u=${amount}`], [{ asset: ASSET, amount: Number(amount) }]);

// ---- EVM side ---------------------------------------------------------------------------------
let ethers = null, provider = null, wallet = null;
async function evmInit() {
  if (EVM.startsWith('mock:')) return;
  ethers = await import('ethers');
  provider = new ethers.JsonRpcProvider(EVM);
  if (process.env.BRIDGE_EVM_KEY) wallet = new ethers.Wallet(process.env.BRIDGE_EVM_KEY, provider);
}
const bridgeEvm = () => wallet ? wallet.address.toLowerCase() : env('BRIDGE_EVM_ADDRESS', '').toLowerCase();
// USDC transfers to the bridge: [{tx, log, from, amount, block}] with block <= tip - confirmations
async function evmDeposits() {
  if (EVM.startsWith('mock:')) {
    const f = EVM.slice(5); if (!fs.existsSync(f)) return [];
    const list = JSON.parse(fs.readFileSync(f, 'utf8'));
    return list.map(d => ({ tx: d.tx, log: d.log ?? 0, from: d.from.toLowerCase(), amount: String(d.amount), block: d.block ?? 0 }));
  }
  const tip = await provider.getBlockNumber(), from = Number(load('evm-cursor.json', { block: Math.max(0, tip - 5000) }).block);
  const to = tip - CONF; if (to < from) return [];
  const usdc = new ethers.Contract(USDC, ['event Transfer(address indexed from, address indexed to, uint256 value)'], provider);
  const out = [];
  for (let a = from; a <= to; a += 2000) {
    const evs = await usdc.queryFilter(usdc.filters.Transfer(null, bridgeEvm()), a, Math.min(to, a + 1999));
    for (const e of evs) out.push({ tx: e.transactionHash, log: e.index, from: e.args.from.toLowerCase(), amount: String(e.args.value), block: e.blockNumber });
  }
  save('evm-cursor.json', { block: to + 1 });
  return out;
}
async function evmSend(to, amount) {
  if (EVM.startsWith('mock:')) return 'mock-withdrawal-' + Date.now();
  const usdc = new ethers.Contract(USDC, ['function transfer(address,uint256) returns (bool)'], wallet);
  const tx = await usdc.transfer(to, BigInt(amount)); await tx.wait(CONF > 1 ? 1 : 1); return tx.hash;
}

// ---- loops ------------------------------------------------------------------------------------
let pendingDeposits = load('pending.json', []);   // deposits seen from addresses that had no link yet
async function depositsRound() {
  const seen = await evmDeposits();
  const all = [...pendingDeposits, ...seen], keep = [], keys = new Set();
  for (const d of all) {
    const key = d.tx + ':' + d.log;
    if (keys.has(key) || done[key]) continue; keys.add(key);
    const link = links[d.from];
    if (!link) { keep.push(d); continue; }       // wait until the sender links a ZP address
    try {
      const tx = await issue(link.zp, d.amount);
      done[key] = { zpTx: tx, amount: d.amount, zp: link.zp, from: d.from }; save('done.json', done);
      log('deposit', d.amount, 'from', d.from, '-> issued to', link.zp, tx);
    } catch (e) { log('deposit failed', key, e.message); keep.push(d); }
  }
  pendingDeposits = keep; save('pending.json', keep);
}

// a withdrawal: the user's transaction pays zUSDC to the bridge's ZP address; the sender must be the linked ZP address
async function withdraw(zpTx, evmTo) {
  const key = 'w:' + zpTx;
  if (done[key]) return done[key];
  const j = await (await fetch(EXPLORER + '/tx/' + zpTx)).json();
  const t = j.transaction; if (!t) throw new Error('transaction not indexed yet');
  const bridgeZp = (await zp('/wallet/address')).toString().replace(/"/g, '');
  const paid = t.outputs.filter(o => o[0] === bridgeZp && o[1] === ASSET).reduce((s, o) => s + BigInt(o[2]), 0n);
  if (paid <= 0n) throw new Error('the transaction pays no zUSDC to the bridge address');
  const senders = new Set(t.inputs.map(i => i[0]).filter(Boolean));
  const owner = Object.entries(links).find(([, l]) => senders.has(l.zp));
  if (!owner || owner[0] !== evmTo.toLowerCase()) throw new Error('the paying ZP address is not linked to that EVM address');
  const burn = await destroy(paid);
  const out = await evmSend(evmTo, paid);
  done[key] = { evmTx: out, burn, amount: String(paid), to: evmTo }; save('done.json', done);
  log('withdrawal', String(paid), '->', evmTo, out);
  return done[key];
}

// ---- API ----------------------------------------------------------------------------------------
// POST /link      {evm, zp, message, signature}  message = "Link <evm> to <zp>" signed with the EVM key (EIP-191)
// POST /withdraw  {zpTx, evm}
// GET  /status    reserves (USDC held), zUSDC outstanding, counts
const json = (res, code, v) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
const readBody = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 8192) no(new Error('too large')); }); req.on('end', () => ok(b)); });
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/status') {
      const outstanding = Object.values(done).filter(d => d.zpTx).reduce((s, d) => s + BigInt(d.amount), 0n) - Object.values(done).filter(d => d.burn).reduce((s, d) => s + BigInt(d.amount), 0n);
      return json(res, 200, { chain: 'testnet', evm: EVM.startsWith('mock:') ? 'mock' : EVM, bridgeEvm: bridgeEvm(), usdc: USDC, contract: CONTRACT, asset: ASSET,
        links: Object.keys(links).length, deposits: Object.values(done).filter(d => d.zpTx).length, withdrawals: Object.values(done).filter(d => d.burn).length,
        zusdcOutstanding: String(outstanding), pendingDeposits: pendingDeposits.length });
    }
    if (req.method === 'POST' && u.pathname === '/link') {
      const { evm, zp: z, message, signature } = JSON.parse(await readBody(req));
      if (!/^0x[0-9a-fA-F]{40}$/.test(evm) || !decodeAddress(z).hash) throw new Error('bad address');
      if (message !== `Link ${evm} to ${z}`) throw new Error('message must be "Link <evm> to <zp>"');
      if (!EVM.startsWith('mock:')) { const rec = (await import('ethers')).verifyMessage(message, signature); if (rec.toLowerCase() !== evm.toLowerCase()) throw new Error('signature does not match'); }
      links[evm.toLowerCase()] = { zp: z, since: Date.now() }; save('links.json', links);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/withdraw') {
      const { zpTx, evm } = JSON.parse(await readBody(req));
      if (!/^[0-9a-f]{64}$/.test(zpTx) || !/^0x[0-9a-fA-F]{40}$/.test(evm)) throw new Error('bad input');
      return json(res, 200, await withdraw(zpTx, evm));
    }
    json(res, 404, { error: 'unknown path' });
  } catch (e) { json(res, 400, { error: String(e.message || e).slice(0, 200) }); }
}).listen(Number(PORT), HOST, () => log('bridge on', HOST + ':' + PORT));

await evmInit();
for (;;) { try { await depositsRound(); } catch (e) { log('round failed:', e.message); } await new Promise(r => setTimeout(r, INTERVAL)); }
