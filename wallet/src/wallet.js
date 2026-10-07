// A wallet in ZP Wallet: one recovery phrase, extended key, single private key, or a watch-only
// address, on one network. Finds the addresses in use, reads balances and history from a node,
// and builds, signs and publishes transfers. Secrets stay in memory only while unlocked.
import { accountFromMnemonic, deriveKey, encodeAddress, decodeAddress, parsePrivateKey } from './keys.js';
import { buildTransaction, maturityFor, MAX_AMOUNT } from './tx.js';
import { unhex, hex, ZEN_ASSET } from './serialize.js';

export const GAP_LIMIT = 20;
export const BRANCHES = [0, 1, 2];            // receive, change, payment (as zen-node uses them)

// Turn the stored secret of a wallet record into keys.
export function openWallet(record, secret) {
  const w = { id: record.id, name: record.name, network: record.network, kind: record.kind,
              account: null, keys: new Map(), watch: [] };
  if (record.kind === 'mnemonic') w.account = accountFromMnemonic(secret);
  else if (record.kind === 'key') {
    const p = parsePrivateKey(secret);
    if (p.kind === 'account') w.account = p.account; else addKey(w, p.key);
  } else if (record.kind === 'watch') {
    for (const a of record.addresses) {
      const d = decodeAddress(a);
      if (d.chain !== record.network) throw new Error('Address is for another network');
      w.watch.push(a);
    }
  } else throw new Error('Unknown wallet type');
  if (w.account) addKey(w, deriveKey(w.account, 0, 0));       // receive address 0 always present
  return w;
}

function addKey(w, k) { w.keys.set(hex(k.pkHash), k); }

export const addressOf = (w, k) => encodeAddress(k.pkHash, w.network);
export function addresses(w) { return [...[...w.keys.values()].map(k => addressOf(w, k)), ...w.watch]; }
export function receiveAddress(w) {
  if (w.watch.length) return w.watch[0];
  if (w.account) return encodeAddress(deriveKey(w.account, 0, 0).pkHash, w.network);
  return addressOf(w, [...w.keys.values()][0]);
}
export const canSpend = w => w.keys.size > 0;

// Find addresses with history on each branch, stopping after GAP_LIMIT unused in a row.
export async function discover(w, node) {
  if (!w.account) return addresses(w);
  for (const branch of BRANCHES) {
    let start = 0;
    for (;;) {
      const batch = [];
      for (let i = start; i < start + GAP_LIMIT; i++) batch.push(deriveKey(w.account, branch, i));
      const res = await node.discovery(batch.map(k => encodeAddress(k.pkHash, w.network)));
      const used = new Set((res || []).filter(r => r.hasTxs || r.hasBalance).map(r => r.address));
      let any = false;
      for (const k of batch) if (used.has(encodeAddress(k.pkHash, w.network))) { addKey(w, k); any = true; }
      if (!any) break;
      start += GAP_LIMIT;
    }
  }
  return addresses(w);
}

const hex64 = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const lockFromJson = l => {
  if (l && l.PK && hex64(l.PK.hash)) return { type: 'PK', hash: unhex(l.PK.hash) };
  if (l && l.Coinbase && hex64(l.Coinbase.pkHash) && Number.isSafeInteger(l.Coinbase.blockNumber))
    return { type: 'Coinbase', blockNumber: l.Coinbase.blockNumber, pkHash: unhex(l.Coinbase.pkHash) };
  return null;                                                   // contract and other locks are not ours to spend
};
// Balances per asset, split into spendable and maturing (coinbase younger than 100 blocks).
// The node is not trusted: anything malformed is refused or dropped here, before the UI sees it.
const isAmount = v => (typeof v === 'string' && /^\d{1,20}$/.test(v)) || (Number.isSafeInteger(v) && v >= 0);
const isHash = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isAsset = v => typeof v === 'string' && /^[0-9a-f]{2,200}$/.test(v);
export const chainOf = name => name === 'main' ? 'main' : (name === 'testnet' || name === 'local' || name === 'test') ? 'test' : null;
export function checkInfo(info, network) {
  if (!info || !Number.isSafeInteger(info.blocks) || info.blocks < 0) throw new Error('The node sent an invalid answer');
  const c = chainOf(info.chain);
  if (network && c && c !== network) throw new Error(`This node is on ${c === 'main' ? 'mainnet' : 'testnet'}, not ${network === 'main' ? 'mainnet' : 'testnet'}`);
  return info;
}

export async function readState(w, node) {
  const addrs = addresses(w);
  const [info, outs] = await Promise.all([node.info(), node.outputs(addrs)]);
  const tip = checkInfo(info, w.network).blocks;
  const maturity = maturityFor(w.network);
  const seen = new Set();
  const assets = new Map();
  const utxos = [];
  if (!Array.isArray(outs)) throw new Error('The node sent an invalid answer');
  for (const o of outs) {
    if (!o?.outpoint || !isHash(o.outpoint.txHash) || !Number.isSafeInteger(o.outpoint.index) || !o.spend
        || !isAsset(o.spend.asset) || !isAmount(o.spend.amount)) continue;
    const id = o.outpoint.txHash + ':' + o.outpoint.index;
    if (seen.has(id)) continue;
    seen.add(id);
    const lock = lockFromJson(o.lock);
    if (!lock) continue;                                            // contract or unknown lock: not ours to spend
    const amount = BigInt(o.spend.amount);
    if (amount > MAX_AMOUNT) continue;
    const a = assets.get(o.spend.asset) || { asset: o.spend.asset, spendable: 0n, maturing: 0n, maturesAt: null };
    const mature = lock.type !== 'Coinbase' || tip + 1 - lock.blockNumber >= maturity;
    if (mature) a.spendable += amount; else {
      a.maturing += amount;
      const at = lock.blockNumber + maturity - 1;
      a.maturesAt = a.maturesAt === null ? at : Math.min(a.maturesAt, at);
    }
    assets.set(o.spend.asset, a);
    utxos.push({ outpoint: { txHash: unhex(o.outpoint.txHash), index: o.outpoint.index }, lock,
                           spend: { asset: o.spend.asset, amount } });
  }
  return { tip, info, assets: [...assets.values()], utxos };
}

export async function readHistory(w, node, skip = 0, take = 30) {
  const rows = await node.history(addresses(w), skip, take);
  if (!Array.isArray(rows)) throw new Error('The node sent an invalid answer');
  return rows.filter(h => h && typeof h.amount === 'string' && /^-?\d{1,20}$/.test(h.amount) && isAsset(h.asset)
    && (h.confirmations === undefined || (Number.isSafeInteger(h.confirmations) && h.confirmations >= 0))
    && (h.timestamp === undefined || h.timestamp === null || Number.isFinite(h.timestamp)));
}

// Build and sign a transfer of `amount` (kalapas) of ZP to `to`; returns { hash, hex } without publishing.
export function prepareSend(w, state, to, amount) {
  if (!canSpend(w)) throw new Error('This is a watch-only wallet');
  const d = decodeAddress(to);
  if (d.chain !== w.network) throw new Error(`That is a ${d.chain === 'main' ? 'mainnet' : 'testnet'} address`);
  if (d.contract) throw new Error('Sending to contract addresses is done from the Contracts screen');
  const keyFor = u => w.keys.get(hex(u.lock.type === 'PK' ? u.lock.hash : u.lock.pkHash));
  const utxos = state.utxos
    .filter(u => u.spend.asset === '00' && keyFor(u))
    .map(u => ({ ...u, spend: { asset: ZEN_ASSET, amount: u.spend.amount }, key: keyFor(u) }));
  const changeHash = decodeAddress(receiveAddress(w)).hash;
  return buildTransaction({
    utxos, tipBlockNumber: state.tip, maturity: maturityFor(w.network),
    payments: [{ lock: { type: 'PK', hash: d.hash }, spend: { asset: ZEN_ASSET, amount } }],
    changeLock: { type: 'PK', hash: changeHash },
  });
}

export async function publish(node, prepared) {
  const res = await node.publish(prepared.hex);
  if (typeof res === 'string' && /^[0-9a-f]{64}$/.test(res) && res !== prepared.hash)
    throw new Error('The node answered with a different transaction hash: check your history before sending again');
  return prepared.hash;
}

