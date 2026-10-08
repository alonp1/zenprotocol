// Market maker for the ZenDex (testnet): keeps one sell-ZP and one buy-ZP order open around a reference price, so the Dex always has liquidity.
//   sell order: gives ZP, wants zUSDC at  price x (1 + spread)
//   buy order:  gives zUSDC, wants ZP at  price x (1 - spread)
// When the reference price moves by more than MM_REQUOTE_BPS, or an order has been taken, the old order is cancelled and a new one made.
// Prices are USD per 1 ZP. 1 ZP = 1e8 kalapas, zUSDC has 6 decimals.
//
// Environment:
//   MM_NODE (http://127.0.0.1:31567)  MM_PASSWORD  MM_SIGN (m/44'/258'/0'/0/0, a wallet address so proceeds show in the wallet)
//   MM_DEX      Dex contract address (ctzn1...)       MM_ASSET  zUSDC asset id (hex)
//   MM_PRICE    fixed reference price in USD per ZP (default 0.10)
//   MM_ORACLE   oracle service url + ticker, e.g. http://127.0.0.1:8085/ZPUSD : takes the price from the latest round instead (falls back to MM_PRICE)
//   MM_SPREAD_BPS (100 = 1% each side)  MM_REQUOTE_BPS (50)  MM_SIZE_ZP (ZP per order, 100)  MM_INTERVAL (30 s)
//   MM_EXPLORER (http://127.0.0.1:11581/explorer/api)   MM_ZO (command that runs zen-oracle, for building message bodies)
//   MM_WAIT (1800 s)  how long a Make/Cancel is assumed to be on its way: the index trails the node by about 10 blocks, so a new order shows up in it only after that
//   MM_DRY=1    only print what it would do
import { execFileSync } from 'node:child_process';

const env = (k, d) => process.env[k] ?? d;
const NODE = env('MM_NODE', 'http://127.0.0.1:31567'), PW = env('MM_PASSWORD', 'testnet'), SIGN = env('MM_SIGN', "m/44'/258'/0'/0/0");
const DEX = env('MM_DEX', ''), USDC = env('MM_ASSET', ''), EXPLORER = env('MM_EXPLORER', 'http://127.0.0.1:11581/explorer/api');
const FIXED = Number(env('MM_PRICE', '0.10')), ORACLE = env('MM_ORACLE', '');
const SPREAD = Number(env('MM_SPREAD_BPS', '100')) / 1e4, REQUOTE = Number(env('MM_REQUOTE_BPS', '50')) / 1e4;
const SIZE = Number(env('MM_SIZE_ZP', '100')), EVERY = Number(env('MM_INTERVAL', '30')) * 1000, DRY = env('MM_DRY', '') === '1';
const ZO = env('MM_ZO', 'dotnet /app/zen-oracle.dll').split(' ');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function node(path, body) {
  const r = await fetch(NODE + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}
const zoBody = specs => execFileSync(ZO[0], [...ZO.slice(1), 'body', ...specs], { encoding: 'utf8' }).trim();
const orderSpecs = o => [`UnderlyingAsset:s=${o.underAsset}`, `UnderlyingAmount:u=${o.underAmount}`, `PairAsset:s=${o.pairAsset}`, `OrderTotal:u=${o.pairTotal}`, `MakerPubKey:k=${o.maker}`];

async function execute(command, o, spends) {
  if (DRY) { log('DRY', command, JSON.stringify(o)); return 'dry'; }
  const r = await node('/wallet/contract/execute', { address: DEX, command, messageBody: zoBody(orderSpecs(o)), options: { sign: SIGN, returnAddress: false }, spends, password: PW });
  if (typeof r !== 'string' || !/^"?[0-9a-f]{64}"?$/.test(r.trim())) throw new Error(`${command}: ${JSON.stringify(r).slice(0, 200)}`);
  return r.replace(/"/g, '').trim();
}

async function referencePrice() {
  if (ORACLE) {
    try {
      const i = ORACLE.lastIndexOf('/'), url = ORACLE.slice(0, i), ticker = ORACLE.slice(i + 1);
      const r = await (await fetch(url + '/rounds/latest')).json();
      const tk = r.tickers ?? r.Tickers, vs = r.values ?? r.Values, j = tk?.indexOf(ticker);
      if (j >= 0 && Number(vs[j]) > 0) return Number(vs[j]);
    } catch (e) { log('oracle price unavailable:', e.message); }
  }
  return FIXED;
}
const balance = async asset => (await node('/wallet/balance')).filter?.(b => b.asset === asset).reduce((s, b) => s + b.balance, 0) ?? 0;

// what we have open now: the explorer's open orders whose maker is our key (amounts there are what is left after partial fills)
async function myOrders(pk) {
  const r = await (await fetch(EXPLORER + '/dex/orders')).json();
  return (r.orders ?? []).filter(o => (o.maker ?? '').toLowerCase() === pk).map(o => ({ underAsset: o.under_asset, underAmount: o.under_amount, pairAsset: o.pair_asset, pairTotal: o.pair_total, maker: pk }));
}
const impliedPrice = o => o.underAsset === '00'
  ? (Number(o.pairTotal) / 1e6) / (Number(o.underAmount) / 1e8)        // sells ZP: usdc per zp
  : (Number(o.underAmount) / 1e6) / (Number(o.pairTotal) / 1e8);       // sells zUSDC: usdc per zp

const pending = {};          // side -> time of the Make/Cancel not yet seen in the index: do not repeat it while it waits to be mined
const WAIT = Number(env('MM_WAIT', '1800')) * 1000, waiting = side => Date.now() - (pending[side] ?? 0) < WAIT;
async function cycle(pk) {
  const price = await referencePrice(), ask = price * (1 + SPREAD), bid = price * (1 - SPREAD);
  const open = await myOrders(pk);
  for (const side of ['ask', 'bid']) if (open.some(o => (o.underAsset === '00') === (side === 'ask'))) delete pending[side];   // seen: no longer pending
  const stale = open.filter(o => Math.abs(impliedPrice(o) / (o.underAsset === '00' ? ask : bid) - 1) > REQUOTE);
  for (const o of stale) { const side = o.underAsset === '00' ? 'ask' : 'bid'; if (waiting('c' + side)) continue; pending['c' + side] = Date.now(); log('cancel', o.underAsset === '00' ? 'ask' : 'bid', 'at', impliedPrice(o).toFixed(5)); log(' tx', await execute('Cancel', o, [])); }
  if (stale.length || waiting('cask') || waiting('cbid')) return;        // let the cancels confirm before making new orders
  const hasAsk = open.some(o => o.underAsset === '00'), hasBid = open.some(o => o.underAsset === USDC);
  if (!hasAsk && !waiting('ask')) {
    pending.ask = Date.now();
    const kalapas = Math.round(SIZE * 1e8), total = Math.round(SIZE * ask * 1e6);
    if (await balance('00') >= kalapas + 1e6) { log(`make ask: sell ${SIZE} ZP for ${total / 1e6} zUSDC (price ${ask.toFixed(5)})`); log(' tx', await execute('Make', { underAsset: '00', underAmount: kalapas, pairAsset: USDC, pairTotal: total, maker: pk }, [{ asset: '00', amount: kalapas }])); }
    else log('not enough ZP for an ask');
  }
  if (!hasBid && !waiting('bid')) {
    pending.bid = Date.now();
    const units = Math.round(SIZE * bid * 1e6), total = Math.round(SIZE * 1e8);
    if (await balance(USDC) >= units) { log(`make bid: buy ${SIZE} ZP with ${units / 1e6} zUSDC (price ${bid.toFixed(5)})`); log(' tx', await execute('Make', { underAsset: USDC, underAmount: units, pairAsset: '00', pairTotal: total, maker: pk }, [{ asset: USDC, amount: units }])); }
    else log('not enough zUSDC for a bid');
  }
}

if (!DEX || !USDC) { console.error('MM_DEX and MM_ASSET are required'); process.exit(1); }
const pk = String(await node('/wallet/publickey', { path: SIGN, password: PW })).replace(/"/g, '').toLowerCase();
log(`market maker: key ${pk.slice(0, 12)}…, size ${SIZE} ZP, spread ${SPREAD * 1e4} bps${DRY ? ', DRY RUN' : ''}`);
for (;;) {
  try { await cycle(pk); } catch (e) { log('cycle failed:', e.message); }
  await new Promise(r => setTimeout(r, EVERY));
}
