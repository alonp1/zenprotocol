// A wallet in ZP Wallet: one recovery phrase, extended key, single private key, or a watch-only
// address, on one network. Finds the addresses in use, reads balances and history from a node,
// and builds, signs and publishes transfers. Secrets stay in memory only while unlocked.
import { accountFromMnemonic, deriveKey, encodeAddress, decodeAddress, parsePrivateKey } from './keys.js';
import { buildTransaction, maturityFor, MAX_AMOUNT } from './tx.js';
import { unhex, hex, ZEN_ASSET, Writer, Outpoint, Output, Data, VarInt, deserializeTx, serializeTx, txHash, witnessesHash, bytesEqual } from './serialize.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { signDigest, verifyDigest } from './tx.js';
import { CGP_PARAMS, phaseAt, voteBody } from './cgp.js';

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
  await Promise.all(BRANCHES.map(async branch => {            // both branches at once: the node answers in parallel
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
  }));
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


// --- CGP votes (PROTOCOL.md 7.5) --------------------------------------------------------------------
// 'Allocation' and payout votes are only counted in the voting phase, 'Nomination' only in the nomination
// phase. The block that includes the transaction decides the phase the ballot was signed for, so the wallet
// signs for tip + 1 and refuses when too few blocks are left.
export const VOTE_MARGIN = 2;
const contractIdOf = idHex => {
  if (!/^[0-9a-f]{72}$/.test(idHex)) throw new Error('Invalid voting contract id');
  return { version: parseInt(idHex.slice(0, 8), 16), hash: unhex(idHex.slice(8)) };
};
const skeletonHex = (inputs, outputs) => {            // TxSkeleton (4.11): PointedOutput inputs, then outputs
  const w = new Writer();
  VarInt.write(w, inputs.length);
  for (const i of inputs) { w.u8(1); Outpoint.write(w, i.outpoint); Output.write(w, { lock: i.lock, spend: i.spend }); }
  VarInt.write(w, outputs.length);
  for (const o of outputs) Output.write(w, o);
  return hex(w.out());
};

// voterWallets: unlocked wallets whose keys sign the ballot. The funding wallet `w` pays the 1 kalapa fee.
// Returns { hash, hex, phase } without publishing.
export async function prepareVote({ w, state, node, votingContractId, command, ballotHex, voterKeys }) {
  if (!canSpend(w)) throw new Error('This is a watch-only wallet');
  const params = CGP_PARAMS[w.network];
  const h = state.tip + 1;
  const ph = phaseAt(params, h);
  const want = command === 'Nomination' ? 'Nomination' : 'Vote';
  if (ph.phase !== want) throw new Error(want === 'Nomination' ? 'Nominations are open only in the nomination phase' : 'Votes are open only in the voting phase');
  if (ph.closes - h < VOTE_MARGIN) throw new Error('This phase closes in a few blocks: wait for the next one');
  const cid = contractIdOf(votingContractId);
  const active = await node.activeContracts();
  if (!Array.isArray(active) || !active.some(c => c && c.contractId === votingContractId))
    throw new Error('The voting contract is not active on this network');

  const body = voteBody(params, h, command, ballotHex, voterKeys);
  const keyFor = u => w.keys.get(hex(u.lock.type === 'PK' ? u.lock.hash : u.lock.pkHash));
  const fee = 1n;
  const fund = state.utxos.filter(u => u.spend.asset === '00' && u.lock.type === 'PK' && keyFor(u) && u.spend.amount >= fee)
    .sort((a, b) => (b.spend.amount > a.spend.amount ? 1 : -1))[0];
  if (!fund) throw new Error('You need a little ZP in a spendable output to pay the 1 kalapa fee');
  const spend = amount => ({ asset: ZEN_ASSET, amount });
  const changeLock = { type: 'PK', hash: decodeAddress(receiveAddress(w)).hash };
  const outputs = [];
  if (fund.spend.amount > fee) outputs.push({ lock: changeLock, spend: spend(fund.spend.amount - fee) });
  outputs.push({ lock: { type: 'Fee' }, spend: spend(fee) });
  const inputs = [{ outpoint: fund.outpoint, lock: fund.lock, spend: spend(fund.spend.amount) }];

  const res = await node.executeContract({
    address: encodeAddress(cid.hash, w.network, true), command, messageBody: body.hex,
    options: { sender: '' }, tx: skeletonHex(inputs, outputs),
  });
  if (typeof res !== 'string' || !/^([0-9a-f]{2})+$/.test(res)) throw new Error('The node sent an invalid answer');

  // the node is not trusted: the transaction must be exactly ours plus one voting contract witness
  const tx = deserializeTx(unhex(res));
  const same = (a, b) => { const x = new Writer(), y = new Writer(); Output.write(x, a); Output.write(y, b); return bytesEqual(x.out(), y.out()); };
  if (tx.version !== 0 || tx.contract) throw new Error('The node changed the transaction');
  if (tx.inputs.length !== 1 || tx.inputs[0].type !== 'outpoint' || hex(tx.inputs[0].outpoint.txHash) !== hex(fund.outpoint.txHash)
      || tx.inputs[0].outpoint.index !== fund.outpoint.index) throw new Error('The node changed the inputs');
  if (tx.outputs.length !== outputs.length || !tx.outputs.every((o, i) => same(o, outputs[i]))) throw new Error('The node changed the outputs');
  const cw = tx.witnesses;
  if (cw.length !== 1 || cw[0].type !== 'Contract' || cw[0].command !== command || cw[0].contractId.version !== cid.version
      || hex(cw[0].contractId.hash) !== hex(cid.hash)) throw new Error('The node returned an unexpected contract witness');
  // the body in the witness must be ours, byte for byte
  if (!cw[0].messageBody) throw new Error('The node changed the vote');
  const ew = new Writer(); Data.write(ew, cw[0].messageBody);
  if (hex(ew.out()) !== body.hex) throw new Error('The node changed the vote');

  // the last PK witness signs "FollowingWitnesses": the transaction hash and the contract witness after it
  const digest = txHash(tx);
  const msg = sha3_256(Uint8Array.from([...digest, ...witnessesHash(cw)]));
  const key = keyFor(fund);
  const pkw = { type: 'PK', sigHash: 'FollowingWitnesses', publicKey: key.publicKey, signature: signDigest(key.privateKey, msg) };
  if (!verifyDigest(pkw.signature, msg, key.publicKey)) throw new Error('Signing failed');
  const signed = { ...tx, witnesses: [pkw, ...cw] };
  return { hash: hex(digest), hex: hex(serializeTx(signed)), phase: ph, signers: body.signers };
}
