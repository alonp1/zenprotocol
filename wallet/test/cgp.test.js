import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { allocationRange, CGP_PARAMS as P, allocationBallot, payoutBallot, hashBallot, voteBody, phaseAt, getInterval, isNomineePhase } from '../src/cgp.js';
import { Data, Reader, Writer, hex, unhex, ZEN_ASSET } from '../src/serialize.js';
import { verifyDigest } from '../src/tx.js';
import { encodeAddress } from '../src/keys.js';

test('phases follow Chain.fs (mainnet and testnet)', () => {
  assert.equal(getInterval(P.main, 1), 1); assert.equal(getInterval(P.main, 10000), 1); assert.equal(getInterval(P.main, 10001), 2);
  assert.equal(isNomineePhase(P.main, 9000), false); assert.equal(isNomineePhase(P.main, 9001), true);
  assert.equal(isNomineePhase(P.main, 9500), true); assert.equal(isNomineePhase(P.main, 9501), false);
  assert.deepEqual(phaseAt(P.main, 2459600), { interval: 246, phase: 'Vote', opens: 2459501, closes: 2460000 });
  assert.equal(phaseAt(P.test, 91).phase, 'Nomination'); assert.equal(phaseAt(P.test, 96).phase, 'Vote');
});

test('allocation ballot and the worked example of PROTOCOL.md 7.3', () => {
  assert.equal(allocationBallot(5), '0105');
  assert.equal(hex(hashBallot(P.main, 2459600, '0105')), 'd37e15c7b7607ccca2771e8019f57e7947f142b47e7e69c480108ca56ddd2f02');
  assert.throws(() => allocationBallot(101)); assert.throws(() => allocationBallot(1.5));
});

test('payout ballot: 1 ZP to a key, and the default nominee (1 kalapa to the CGP contract)', () => {
  const pk = new Uint8Array(32).fill(0x26);
  const b = payoutBallot(encodeAddress(pk, 'main'), [{ asset: ZEN_ASSET, amount: 100000000n }]);
  assert.equal(b, '0201' + '26'.repeat(32) + '01' + '00' + '2001');
  const cgp = unhex('00cdaa2a511cd2e1d07555b00314d1be40a649d3b6f419eb1e4e7a8e63240a36d1'.slice(2));
  assert.equal(payoutBallot(encodeAddress(cgp, 'main', true), [{ asset: ZEN_ASSET, amount: 1n }]),
    '020200cdaa2a511cd2e1d07555b00314d1be40a649d3b6f419eb1e4e7a8e63240a36d101000001');
  assert.throws(() => payoutBallot(encodeAddress(pk, 'main'), []));
  assert.throws(() => payoutBallot(encodeAddress(pk, 'main'), [{ asset: ZEN_ASSET, amount: 0n }]));
  assert.throws(() => payoutBallot(encodeAddress(pk, 'main'), [{ asset: ZEN_ASSET, amount: 1n }, { asset: ZEN_ASSET, amount: 2n }]));
});

test('vote body: Signature first, signatures verify, one signature per key', () => {
  const priv = secp256k1.utils.randomSecretKey(), pub = secp256k1.getPublicKey(priv, true);
  const body = voteBody(P.main, 2459600, 'Allocation', '0105', [{ privateKey: priv, publicKey: pub }, { privateKey: priv, publicKey: pub }]);
  assert.equal(body.signers, 1);
  const d = Data.read(new Reader(unhex(body.hex)));            // strict reader: also proves the key order
  assert.deepEqual(d.v.map(e => e[0]), ['Signature', 'Allocation']);
  const sig = d.v[0][1].v[0];
  assert.equal(sig[0], hex(pub));
  assert.ok(verifyDigest(sig[1].v, unhex(body.digest), pub));
  assert.throws(() => voteBody(P.main, 2459600, 'Allocation', '0105', []));
});

// --- sending a vote: a fake node plays /contract/active and /contract/execute ----------------------
import { deriveKey } from '../src/keys.js';
import { openWallet, prepareVote } from '../src/wallet.js';
import { deserializeTx, serializeTx, txHash, witnessesHash, Output, Outpoint, VarInt } from '../src/serialize.js';
import { sha3_256 } from '@noble/hashes/sha3.js';

const VOTING = '00000000e89738718a802a7d217941882efe8e585e20b20901391bc37af25fac2f22c8ab';
const phrase = Array(23).fill('abandon').concat('art');
function fixture({ tip, tamper } = {}) {
  const w = openWallet({ id: 'a', name: 'a', network: 'test', kind: 'mnemonic' }, phrase.join(' '));
  const k = deriveKey(w.account, 0, 0);
  const utxo = { outpoint: { txHash: new Uint8Array(32).fill(7), index: 0 }, lock: { type: 'PK', hash: k.pkHash }, spend: { asset: '00', amount: 500000000n } };
  const state = { tip, utxos: [utxo] };
  const node = {
    activeContracts: async () => [{ contractId: VOTING }],
    // the node: reads the skeleton, returns Full tx with a contract witness (what /contract/execute does)
    executeContract: async b => {
      const r = new Reader(unhex(b.tx));
      const n = VarInt.read(r), inputs = [];
      for (let i = 0; i < n; i++) { assert.equal(r.u8(), 1); inputs.push({ type: 'outpoint', outpoint: Outpoint.read(r) }); Output.read(r); }
      const m = VarInt.read(r), outputs = []; for (let i = 0; i < m; i++) outputs.push(Output.read(r));
      const body = Data.read(new Reader(unhex(b.messageBody)));
      let tx = { version: 0, inputs, outputs, contract: null, witnesses: [{ type: 'Contract',
        contractId: { version: 0, hash: unhex(VOTING.slice(8)) }, command: b.command, messageBody: body, stateCommitment: { type: 'NotCommitted' },
        beginInputs: inputs.length, beginOutputs: outputs.length, inputsLength: 0, outputsLength: 0, signature: null, cost: 5n }] };
      if (tamper) tx = tamper(tx);
      return hex(serializeTx(tx));
    },
  };
  return { w, k, state, node };
}

test('a vote transaction: the fee is paid, the last PK witness signs FollowingWitnesses over the contract witness', async () => {
  const f = fixture({ tip: 95 });                          // testnet: block 96 is the first voting block
  const out = await prepareVote({ w: f.w, state: f.state, node: f.node, votingContractId: VOTING, command: 'Allocation',
    ballotHex: allocationBallot(5), voterKeys: [f.k] });
  const tx = deserializeTx(unhex(out.hex));
  assert.equal(out.phase.phase, 'Vote');
  assert.equal(tx.witnesses.length, 2);
  assert.equal(tx.witnesses[0].type, 'PK'); assert.equal(tx.witnesses[0].sigHash, 'FollowingWitnesses');
  assert.equal(tx.witnesses[1].type, 'Contract');
  const msg = sha3_256(Uint8Array.from([...txHash(tx), ...witnessesHash([tx.witnesses[1]])]));
  assert.ok(verifyDigest(tx.witnesses[0].signature, msg, f.k.publicKey));
  assert.equal(tx.outputs.at(-1).lock.type, 'Fee'); assert.equal(tx.outputs.at(-1).spend.amount, 1n);
  assert.equal(tx.outputs[0].spend.amount, 499999999n);
});

test('wrong phase, last blocks of a phase, and a node that changes the transaction are refused', async () => {
  const run = (tip, command, tamper) => { const f = fixture({ tip, tamper });
    return prepareVote({ w: f.w, state: f.state, node: f.node, votingContractId: VOTING, command, ballotHex: allocationBallot(5), voterKeys: [f.k] }); };
  await assert.rejects(run(91, 'Allocation'), /voting phase/);                    // block 92 is a nomination block
  await assert.rejects(run(95, 'Nomination'), /nomination phase/);               // block 96 is a voting block
  await assert.rejects(run(98, 'Allocation'), /closes in a few blocks/);         // block 99 of 100
  await assert.rejects(run(95, 'Allocation', tx => ({ ...tx, outputs: tx.outputs.slice(1) })), /changed the outputs/);
  await assert.rejects(run(95, 'Allocation', tx => ({ ...tx, witnesses: [{ ...tx.witnesses[0], command: 'Payout' }] })), /unexpected contract witness/);
  await assert.rejects(run(95, 'Allocation', tx => ({ ...tx, witnesses: [{ ...tx.witnesses[0],
    messageBody: { t: 'String', v: 'x' } }] })), /changed the vote/);
});

test('allowed allocation votes: 90% in force allows 89 and 90 only; 0% allows 0 to 15', () => {
  assert.deepEqual(allocationRange(P.main, 90), { min: 89, max: 90 });
  assert.deepEqual(allocationRange(P.main, 0), { min: 0, max: 15 });
  assert.deepEqual(allocationRange(P.main, 50), { min: 42, max: 58 });
});
