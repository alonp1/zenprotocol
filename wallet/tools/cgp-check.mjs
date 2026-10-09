// Read-only readiness check of CGP voting against a node (mainnet or testnet), with a throwaway wallet that holds nothing:
// the node EXECUTES the voting contract on a ballot (what the wallet does before signing) but nothing is signed with real
// keys and nothing is published. usage: node tools/cgp-check.mjs [--net main|test] [--node http://127.0.0.1:11567]
import { NodeClient } from '../src/node.js';
import { newMnemonic, deriveKey } from '../src/keys.js';
import { openWallet, prepareVote } from '../src/wallet.js';
import { ZP } from '../src/tx.js';
import { CGP_PARAMS, VOTING_CONTRACT, phaseAt, snapshotBlock, allocationRange, allocationBallot, payoutBallot } from '../src/cgp.js';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const NET = arg('net', 'main'), node = new NodeClient(arg('node', NET === 'main' ? 'http://127.0.0.1:11567' : 'http://127.0.0.1:31567'));
const params = CGP_PARAMS[NET], voting = VOTING_CONTRACT[NET];
let bad = 0;
const ok = (m) => console.log('OK   ', m), fail = (m) => { bad++; console.log('FAIL ', m); };

const info = await node.info();
const tip = info.blocks;
(info.chain === (NET === 'main' ? 'main' : 'testnet') ? ok : fail)(`node chain "${info.chain}", tip ${tip}`);

const cgp = await node.cgp().catch(e => (fail('blockchain/cgp: ' + e.message), {}));
const last = Number.isInteger(cgp.allocation) ? cgp.allocation : null;
if (last !== null) {
  const r = allocationRange(params, last);
  ok(`allocation in force ${last}% (CGP) · ${100 - last}% (miners); the next vote may be ${r.min}%-${r.max}% for the CGP`);
}
const ph = phaseAt(params, tip + 1), len = params.intervalLength, ivStart = (ph.interval - 1) * len;
ok(`next block ${tip + 1}: interval ${ph.interval}, phase ${ph.phase}; snapshot ${snapshotBlock(params, ph.interval)}, nominations ${snapshotBlock(params, ph.interval) + 1}-${snapshotBlock(params, ph.interval) + params.nomination}, voting until ${ivStart + len}`);

const active = await node.activeContracts().catch(e => (fail('contract/active: ' + e.message), []));
const row = Array.isArray(active) ? active.find(c => c && c.contractId === voting) : null;
if (!row) fail(`the voting contract ${voting} is NOT active: nobody can vote`);
else {
  const exp = row.expire;
  ok(`voting contract active${exp != null ? ', expires at block ' + exp + (Number(exp) > tip ? ` (${(Number(exp) - tip).toLocaleString()} blocks, about ${Math.round((Number(exp) - tip) * 237 / 86400)} days left)` : ' - EXPIRED') : ''}`);
  if (exp != null && Number(exp) <= tip + 20000) fail('the voting contract expires within about 55 days: plan its reactivation');
}

// the node executes the voting contract for ballots built exactly like the wallet builds them
const w = openWallet({ id: 'check', name: 'check', network: NET, kind: 'mnemonic' }, newMnemonic());
const k = deriveKey(w.account, 0, 0);
const state = { tip, utxos: [{ outpoint: { txHash: new Uint8Array(32).fill(9), index: 0 }, lock: { type: 'PK', hash: k.pkHash }, spend: { asset: '00', amount: 100000000n } }] };
const tryVote = async (what, command, ballotHex) => {
  try {
    const p = await prepareVote({ w, state, node, votingContractId: voting, command, ballotHex, voterKeys: [k], anyPhase: true });
    ok(`${what}: the node executed the voting contract and answered; the wallet verified the answer (tx ${p.hash.slice(0, 12)}…, not published)`);
  } catch (e) { fail(`${what}: ${e.message}`); }
};
if (last !== null) await tryVote(`allocation ballot ${last}%`, 'Allocation', allocationBallot(last));
const addr = (await import('../src/keys.js')).encodeAddress(k.pkHash, NET);
await tryVote('payout ballot to a wallet address', 'Payout', payoutBallot(addr, [{ asset: ZP, amount: 100000000n }]));
await tryVote('nomination to a wallet address', 'Nomination', payoutBallot(addr, [{ asset: ZP, amount: 100000000n }]));
const cands = await node.candidates().catch(e => (fail('blockchain/candidates: ' + e.message), null));
if (cands) ok(`candidates endpoint answers (${Array.isArray(cands) ? cands.length : '?'} now)`);
console.log(bad ? `\n${bad} problem(s)` : '\nall checks passed');
process.exit(bad ? 1 : 0);
