#!/usr/bin/env node
// Read-only check of the wallet's vote code against REAL mainnet votes: for recent CGP ballots found by the indexer,
//   - the transaction re-serializes byte for byte (so the Dict key order of the wallet's writer is the chain's),
//   - every ballot signature verifies with the wallet's hashBallot (phase, interval and ballot text),
//   - the PK witness with sigHash FollowingWitnesses verifies with the wallet's message (txHash + witnesses after it).
// usage: node --experimental-sqlite tools/verify-real-votes.mjs [--db /var/lib/zen-stats/chain-index.sqlite] [--node http://127.0.0.1:11567] [--limit 40]
import { DatabaseSync } from 'node:sqlite';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { NodeClient } from '../src/node.js';
import { deserializeTx, serializeTx, txHash, witnessesHash, hex, unhex } from '../src/serialize.js';
import { verifyDigest } from '../src/tx.js';
import { candidateBallot, CGP_PARAMS, VOTING_CONTRACT, hashBallot, hashBallotFor, phaseAt } from '../src/cgp.js';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const db = new DatabaseSync(arg('db', '/var/lib/zen-stats/chain-index.sqlite'), { readOnly: true });
const node = new NodeClient(arg('node', 'http://127.0.0.1:11567'));
const rows = db.prepare('SELECT hash, block, command FROM txs WHERE contract = ? ORDER BY block DESC LIMIT ?').all(VOTING_CONTRACT.main, Number(arg('limit', 40)));
console.log(`${rows.length} voting-contract transactions found`);
const tally = { txs: 0, roundTrip: 0, signatures: 0, signaturesOk: 0, following: 0, followingOk: 0 };
const bad = [], byCommand = {};
for (const r of rows) {
  const res = await node.request(`/blockchain/transaction?hash=${r.hash}&hex=true`);
  const raw = unhex(res.tx), tx = deserializeTx(raw);
  tally.txs++;
  if (hex(serializeTx(tx)) === hex(raw)) tally.roundTrip++; else bad.push(`${r.hash}: re-serialization differs (dict key order?)`);
  const digest = txHash(tx);
  for (const [i, w] of tx.witnesses.entries()) {
    if (w.type === 'PK' && w.sigHash === 'FollowingWitnesses') {
      tally.following++;
      const msg = sha3_256(Uint8Array.from([...digest, ...witnessesHash(tx.witnesses.slice(i + 1))]));
      if (verifyDigest(w.signature, msg, w.publicKey)) tally.followingOk++; else bad.push(`${r.hash}: FollowingWitnesses signature does not verify`);
    }
    if (w.type === 'Contract' && w.messageBody?.t === 'Dict') {
      const m = new Map(w.messageBody.v), sigs = m.get('Signature'), ballot = [...m].find(([k]) => k !== 'Signature');
      if (!sigs || !ballot) continue;
      const hash = hashBallot(CGP_PARAMS.main, r.block, ballot[1].v);
      for (const [pk, s] of sigs.v) {
        tally.signatures++;
        const c = byCommand[r.command] ||= { ok: 0, notOk: 0 };
        if (verifyDigest(s.v, hash, unhex(pk))) { tally.signaturesOk++; c.ok++; }
        else {
          c.notOk++;
          // a wallet signs for the block it expects; a transaction mined later (another phase or interval) is ignored by the tally. Find the block it was signed for.
          let signedFor = null;      // which interval and phase did the voter sign for?
          for (let i = 1; i <= 400 && !signedFor; i++) for (const ph of ['Nomination', 'Vote'])
            if (!signedFor && verifyDigest(s.v, hashBallotFor(i, ph, ballot[1].v), unhex(pk))) signedFor = { interval: i, phase: ph };
          let note = '';
          if (r.command === 'Nomination' || r.command === 'Payout') {      // does the node count this nomination as a candidate? (only the ones above 3% appear)
            const iv = phaseAt(CGP_PARAMS.main, r.block).interval;
            const cands = await node.request(`/blockchain/candidates?interval=${iv}`).catch(() => null);
            const found = Array.isArray(cands) && cands.some(c => { try { return candidateBallot(c) === ballot[1].v; } catch { return false; } });
            note = ` | the node lists this ballot as a candidate of interval ${iv}: ${Array.isArray(cands) ? (found ? 'YES (my check is wrong!)' : `no (${cands.length} candidates)`) : 'unknown'}`;
          }
          bad.push(`${r.hash} (block ${r.block}, ${r.command}, phase ${phaseAt(CGP_PARAMS.main, r.block).phase}): signature does not verify for this block; ` + (signedFor ? `it was signed for interval ${signedFor.interval}, ${signedFor.phase} phase (this block is interval ${phaseAt(CGP_PARAMS.main, r.block).interval}, ${phaseAt(CGP_PARAMS.main, r.block).phase})` : 'no interval/phase combination matches: the signed text is different') + note);
        }
      }
    }
  }
}
console.log(tally); console.log('by command:', JSON.stringify(byCommand));
console.log(bad.length ? 'PROBLEMS:\n' + bad.slice(0, 20).join('\n') : 'ALL CHECKS PASS: the wallet signs and encodes votes the way the chain does');
