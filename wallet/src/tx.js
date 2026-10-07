// Build and sign ZP transactions (port of Wallet/TransactionCreator.fs + Consensus/Transaction.fs).
// - no fee output: the node wallet does not add one either
// - one PK witness per input, in input order, each signing the transaction hash (SigHash TxHash)
// - signature: secp256k1 ECDSA over the 32-byte tx hash, RFC6979 nonce, low-S, compact 64 bytes
//   (libsecp256k1 secp256k1_ecdsa_sign with the default nonce function)
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { txHash, serializeTx, hex, ZEN_ASSET, assetToString } from './serialize.js';

export const COINBASE_MATURITY = 100;                              // mainnet (Consensus/Chain.fs)
export const maturityFor = network => network === 'test' ? 10 : COINBASE_MATURITY;
export const MAX_AMOUNT = 2n ** 64n - 1n;

export function signDigest(privateKey, digest) {
  return secp256k1.sign(digest, privateKey, { prehash: false, lowS: true });
}
export function verifyDigest(signature, digest, publicKey) {
  return secp256k1.verify(signature, digest, publicKey, { prehash: false, lowS: true });
}

const keyOf = asset => assetToString(asset);

// utxos: [{ outpoint:{txHash,index}, lock:{type,...}, spend:{asset,amount}, key:{privateKey,publicKey} }]
// payments: [{ lock, spend:{asset, amount} }], changeLock: lock for change outputs
export function buildTransaction({ utxos, payments, changeLock, tipBlockNumber, contract = null, maturity = COINBASE_MATURITY }) {
  const need = new Map();
  for (const p of payments) {
    if (p.spend.amount <= 0n) throw new Error('Amount must be positive');
    if (p.spend.amount > MAX_AMOUNT) throw new Error('Amount too large');
    const k = keyOf(p.spend.asset);
    need.set(k, { asset: p.spend.asset, amount: (need.get(k)?.amount ?? 0n) + p.spend.amount });
  }
  const spendable = utxos.filter(u => u.lock.type !== 'Coinbase' ||
    tipBlockNumber + 1 - u.lock.blockNumber >= maturity);

  const chosen = [], change = [];
  for (const [k, { asset, amount }] of need) {
    // largest first keeps transactions small
    const pool = spendable.filter(u => keyOf(u.spend.asset) === k).sort((a, b) => (b.spend.amount > a.spend.amount ? 1 : b.spend.amount < a.spend.amount ? -1 : 0));
    let sum = 0n;
    for (const u of pool) { if (sum >= amount) break; chosen.push(u); sum += u.spend.amount; }
    if (sum < amount) throw new Error(`Not enough funds (${k === '00' ? 'ZP' : 'asset ' + k})`);
    if (sum > amount) change.push({ lock: changeLock, spend: { asset, amount: sum - amount } });
  }

  const tx = {
    version: 0,
    inputs: chosen.map(u => ({ type: 'outpoint', outpoint: u.outpoint })),
    outputs: [...payments, ...change],
    contract,
    witnesses: [],
  };
  return signTransaction(tx, chosen.map(u => u.key));
}

export function signTransaction(tx, keys) {
  const digest = txHash(tx);
  const witnesses = keys.map(k => ({ type: 'PK', sigHash: 'TxHash', publicKey: k.publicKey,
                                     signature: signDigest(k.privateKey, digest) }));
  const signed = { ...tx, witnesses: [...witnesses, ...tx.witnesses] };
  return { tx: signed, hash: hex(digest), hex: hex(serializeTx(signed)) };
}

export const ZP = ZEN_ASSET;
export const KALAPAS = 100_000_000n;
export function parseZP(text) {
  const m = String(text).trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error('Invalid amount');
  const v = BigInt(m[1]) * KALAPAS + BigInt((m[2] || '').padEnd(8, '0'));
  if (v > MAX_AMOUNT) throw new Error('Amount too large');
  return v;
}
export function formatZP(kalapas) {
  const n = BigInt(kalapas), neg = n < 0n, k = neg ? -n : n, whole = k / KALAPAS, frac = (k % KALAPAS).toString().padStart(8, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toLocaleString('en-US') + (frac ? '.' + frac : '');
}
