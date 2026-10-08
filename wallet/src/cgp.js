// CGP ballots: allocation vote, payout nomination, payout vote (PROTOCOL.md section 7).
// This file builds and signs the ballots and the message body of the voting contract.
// Sending them (contract/execute, signing the transaction, publishing) is in wallet.js.
import { sha3_256 } from '@noble/hashes/sha3.js';
import { Writer, Data, Spend, VarInt, hex, unhex, assetToString } from './serialize.js';
import { decodeAddress } from './keys.js';
import { signDigest } from './tx.js';

// Chain.fs: mainnet interval 10,000 / snapshot 9,000 / nomination 500; testnet 100 / 90 / 5
export const CGP_PARAMS = {
  main: { intervalLength: 10000, snapshot: 9000, nomination: 500, upperAllocationBound: 90, allocationCorrectionCap: 15 },
  test: { intervalLength: 100, snapshot: 90, nomination: 5, upperAllocationBound: 90, allocationCorrectionCap: 15 },
};

export const getInterval = (p, bn) => bn > 0 ? Math.floor((bn - 1) / p.intervalLength) + 1 : 1;
export const snapshotBlock = (p, i) => (i - 1) * p.intervalLength + p.snapshot;
export const isNomineePhase = (p, bn) => {
  const s = snapshotBlock(p, getInterval(p, bn));
  return s < bn && bn <= s + p.nomination;
};
export const phaseAt = (p, bn) => {
  const i = getInterval(p, bn), s = snapshotBlock(p, i);
  if (bn <= s) return { interval: i, phase: 'before', opens: s + 1, closes: s };
  if (bn <= s + p.nomination) return { interval: i, phase: 'Nomination', opens: s + 1, closes: s + p.nomination };
  return { interval: i, phase: 'Vote', opens: s + p.nomination + 1, closes: i * p.intervalLength };
};

// --- ballots ------------------------------------------------------------------------------------
const bytesOf = fn => { const w = new Writer(); fn(w); return w.out(); };

export function allocationBallot(percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error('Allocation must be a whole number from 0 to 100');
  return hex(Uint8Array.of(1, percent));
}

// recipient: a ZP address (PK or contract); spends: [{asset, amount (bigint kalapas)}]
export function payoutBallot(recipientAddress, spends) {
  const d = decodeAddress(recipientAddress);
  if (!Array.isArray(spends) || spends.length < 1 || spends.length > 100) throw new Error('A payout needs 1 to 100 spends');
  const sorted = [...spends].sort((a, b) => cmpAsset(a.asset, b.asset));
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].amount <= 0n) throw new Error('Every amount must be greater than zero');
    if (i && cmpAsset(sorted[i - 1].asset, sorted[i].asset) === 0) throw new Error('The same asset appears twice');
  }
  return hex(bytesOf(w => {
    w.u8(2);
    if (d.contract) { w.u8(2); VarInt.write(w, 0); w.bytes(d.hash); } else { w.u8(1); w.bytes(d.hash); }
    VarInt.write(w, sorted.length);
    for (const s of sorted) Spend.write(w, s);
  }));
}
// F# structural order on (version, contract hash bytes, subtype bytes)
function cmpAsset(a, b) {
  const x = [a.contract.version, ...a.contract.hash, ...a.subtype], y = [b.contract.version, ...b.contract.hash, ...b.subtype];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// --- what a voter signs ---------------------------------------------------------------------------
const dataHex = d => { const w = new Writer(); Data.write(w, d); return hex(w.out()); };
export function hashBallot(params, blockNumber, ballotHex) {
  const interval = getInterval(params, blockNumber);
  const phase = isNomineePhase(params, blockNumber) ? 'Nomination' : 'Vote';
  const text = dataHex({ t: 'U32', v: interval }) + dataHex({ t: 'String', v: phase }) + dataHex({ t: 'String', v: ballotHex });
  return sha3_256(new TextEncoder().encode(text));
}

// command: 'Allocation' | 'Payout' | 'Nomination'; keys: [{privateKey, publicKey}]
export function voteBody(params, blockNumber, command, ballotHex, keys) {
  if (!['Allocation', 'Payout', 'Nomination'].includes(command)) throw new Error('Unknown vote command');
  if (!keys.length) throw new Error('No wallet selected to sign');
  const digest = hashBallot(params, blockNumber, ballotHex);
  const seen = new Set(), sigs = [];
  for (const k of keys) {
    const pk = hex(k.publicKey);
    if (seen.has(pk)) continue;
    seen.add(pk);
    sigs.push([pk, { t: 'Signature', v: signDigest(k.privateKey, digest) }]);
  }
  const body = { t: 'Dict', v: [[command, { t: 'String', v: ballotHex }], ['Signature', { t: 'Dict', v: sigs }]] };
  const w = new Writer(); Data.write(w, body);
  return { data: body, hex: hex(w.out()), digest: hex(digest), signers: sigs.length };
}

export { assetToString, unhex };
