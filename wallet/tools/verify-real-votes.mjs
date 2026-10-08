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
import { CGP_PARAMS, VOTING_CONTRACT, hashBallot, phaseAt } from '../src/cgp.js';

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
  tx.witnesses.forEach((w, i) => {
    if (w.type === 'PK' && w.sigHash === 'FollowingWitnesses') {
      tally.following++;
      const msg = sha3_256(Uint8Array.from([...digest, ...witnessesHash(tx.witnesses.slice(i + 1))]));
      if (verifyDigest(w.signature, msg, w.publicKey)) tally.followingOk++; else bad.push(`${r.hash}: FollowingWitnesses signature does not verify`);
    }
    if (w.type === 'Contract' && w.messageBody?.t === 'Dict') {
      const m = new Map(w.messageBody.v), sigs = m.get('Signature'), ballot = [...m].find(([k]) => k !== 'Signature');
      if (!sigs || !ballot) return;
      const hash = hashBallot(CGP_PARAMS.main, r.block, ballot[1].v);
      for (const [pk, s] of sigs.v) {
        tally.signatures++;
        const c = byCommand[r.command] ||= { ok: 0, notOk: 0 };
        if (verifyDigest(s.v, hash, unhex(pk))) { tally.signaturesOk++; c.ok++; }
        else {
          c.notOk++;
          // a wallet signs for the block it expects; a transaction mined later (another phase or interval) is ignored by the tally. Find the block it was signed for.
          let signedFor = null;
          for (let d = -400; d <= 400 && signedFor === null; d++) if (verifyDigest(s.v, hashBallot(CGP_PARAMS.main, r.block + d, ballot[1].v), unhex(pk))) signedFor = r.block + d;
          bad.push(`${r.hash} (block ${r.block}, ${r.command}, phase ${phaseAt(CGP_PARAMS.main, r.block).phase}): signature does not verify for this block; ` + (signedFor === null ? 'no block within 400 matches' : `it was signed for block ${signedFor} (phase ${phaseAt(CGP_PARAMS.main, signedFor).phase}, interval ${phaseAt(CGP_PARAMS.main, signedFor).interval})`));
        }
      }
    }
  });
}
console.log(tally); console.log('by command:', JSON.stringify(byCommand));
console.log(bad.length ? 'PROBLEMS:\n' + bad.slice(0, 20).join('\n') : 'ALL CHECKS PASS: the wallet signs and encodes votes the way the chain does');
