// A wallet in ZP Wallet: one recovery phrase, extended key, single private key, or a watch-only
// address, on one network. Finds the addresses in use, reads balances and history from a node,
// and builds, signs and publishes transfers. Secrets stay in memory only while unlocked.
import { accountFromMnemonic, deriveKey, encodeAddress, decodeAddress, parsePrivateKey } from './keys.js';
import { buildTransaction, COINBASE_MATURITY } from './tx.js';
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

const lockFromJson = l => {
  if (l && l.PK) return { type: 'PK', hash: unhex(l.PK.hash) };
  if (l && l.Coinbase) return { type: 'Coinbase', blockNumber: l.Coinbase.blockNumber, pkHash: unhex(l.Coinbase.pkHash) };
  return null;                                                   // contract and other locks are not ours to spend
};
// Balances per asset, split into spendable and maturing (coinbase younger than 100 blocks).
export async function readState(w, node) {
  const addrs = addresses(w);
  const [info, outs] = await Promise.all([node.info(), node.outputs(addrs)]);
  const tip = info.blocks;
  const assets = new Map();
  const utxos = [];
  for (const o of outs || []) {
    const lock = lockFromJson(o.lock);
    const amount = BigInt(o.spend.amount);
    const a = assets.get(o.spend.asset) || { asset: o.spend.asset, spendable: 0n, maturing: 0n, maturesAt: null };
    const mature = !lock || lock.type !== 'Coinbase' || tip + 1 - lock.blockNumber >= COINBASE_MATURITY;
    if (mature) a.spendable += amount; else {
      a.maturing += amount;
      const at = lock.blockNumber + COINBASE_MATURITY - 1;
      a.maturesAt = a.maturesAt === null ? at : Math.min(a.maturesAt, at);
    }
    assets.set(o.spend.asset, a);
    if (lock) utxos.push({ outpoint: { txHash: unhex(o.outpoint.txHash), index: o.outpoint.index }, lock,
                           spend: { asset: o.spend.asset, amount } });
  }
  return { tip, info, assets: [...assets.values()], utxos };
}

export async function readHistory(w, node, skip = 0, take = 30) {
  return node.history(addresses(w), skip, take);
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
    utxos, tipBlockNumber: state.tip,
    payments: [{ lock: { type: 'PK', hash: d.hash }, spend: { asset: ZEN_ASSET, amount } }],
    changeLock: { type: 'PK', hash: changeHash },
  });
}

export async function publish(node, prepared) {
  const res = await node.publish(prepared.hex);
  return typeof res === 'string' ? res : prepared.hash;
}

