#!/usr/bin/env node
// Try CGP ballots on a node from the command line (no browser, no HTTPS needed): waits for the right phase,
// then sends one payout nomination (nomination phase) and one allocation vote + one payout vote (voting phase).
// Dry run by default: builds and checks every transaction but publishes nothing. Add --send to publish.
//   TESTNET_MNEMONIC="word1 ... word24" node tools/cgp-vote.mjs [--node http://127.0.0.1:31567] [--net test] [--send] [--once]
// The wallet's balance at the snapshot block is its weight; a nomination needs 3% of all ZP behind it.
import { NodeClient } from '../src/node.js';
import { openWallet, discover, readState, prepareVote, publish, receiveAddress } from '../src/wallet.js';
import { CGP_PARAMS, VOTING_CONTRACT, phaseAt, allocationBallot, payoutBallot, candidateBallot } from '../src/cgp.js';
import { ZP, formatZP, parseZP } from '../src/tx.js';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || i + 1 >= process.argv.length ? true : process.argv[i + 1]); };
const NET = arg('net', 'test'), SEND = process.argv.includes('--send'), ONCE = process.argv.includes('--once');
const PROBE = process.argv.includes('--probe');   // one end-to-end test now, in ANY phase: the ballot is ignored by the tally, the transaction is real
const STOP_AFTER_VOTE = process.argv.includes('--stop-after-vote');   // exit when this interval's ballots are all sent, or the voting phase is over
const node = new NodeClient(arg('node', 'http://127.0.0.1:31567'));
const phrase = process.env.TESTNET_MNEMONIC;
if (!phrase) { console.error('Set TESTNET_MNEMONIC to the 24 words of the wallet that votes'); process.exit(2); }
const params = CGP_PARAMS[NET], contract = VOTING_CONTRACT[NET];
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const w = openWallet({ id: 'cli', name: 'cli', network: NET, kind: 'mnemonic' }, phrase);
await discover(w, node);
const keys = () => [...w.keys.values()];
const used = [];   // funding outputs of ballots sent but not yet in a block: the next ballot must not reuse them
let nominatedIn = 0, allocIn = 0, payoutIn = 0, lastVotePhase = 0;
say('wallet', receiveAddress(w), `(${keys().length} addresses)`);

async function step() {
  const state = await readState(w, node);
  const h = state.tip + 1, ph = phaseAt(params, h);
  say(`block ${state.tip}, interval ${ph.interval}, phase ${ph.phase}${ph.phase === 'before' ? ` (opens at ${ph.opens})` : ` (closes at ${ph.closes})`}, balance ${formatZP(state.assets.find(a => a.asset === '00')?.spendable ?? 0n)} ZP`);
  const send = async (command, ballotHex, what) => {
    const p = await prepareVote({ w, state, node, votingContractId: contract, command, ballotHex, voterKeys: keys(), exclude: used });
    say(`${what}: transaction ${p.hash} built and checked${SEND ? '' : ' (dry run, not sent)'}`);
    if (SEND) { say(`${what}: published`, await publish(node, p)); used.push(p.spent); }
  };
  if (ph.phase === 'Nomination' && nominatedIn !== ph.interval) {
    // pay 1 ZP from the CGP fund to a second address of this wallet
    await send('Nomination', payoutBallot(receiveAddress(w), [{ asset: ZP, amount: parseZP('1') }]), 'nomination');
    nominatedIn = ph.interval;
  }
  if (ph.phase === 'Vote') {
    lastVotePhase = ph.interval;
    if (allocIn !== ph.interval) {
      const cgp = await node.cgp().catch(() => null);
      const last = Number.isInteger(cgp?.allocation) ? cgp.allocation : 90;
      await send('Allocation', allocationBallot(last), `allocation vote (${last}%, the same as now)`);
      allocIn = ph.interval;
    }
    if (payoutIn !== ph.interval) {
      const cands = await node.candidates().catch(() => []);
      say(`${cands.length} candidate(s)`, JSON.stringify(cands).slice(0, 300));
      const mine = cands.find(c => c.recipient === receiveAddress(w)) || cands[0];
      if (mine) { await send('Payout', candidateBallot(mine), 'payout vote'); payoutIn = ph.interval; }
      else say('no candidate to vote for (a nomination needs 3% of all ZP at the snapshot)');
    }
  }
  // done: both votes sent, or the voting phase has ended
  return allocIn === ph.interval && payoutIn === ph.interval || (lastVotePhase && ph.interval > lastVotePhase);
}
if (PROBE) {
  const state = await readState(w, node), cgp = await node.cgp().catch(() => ({}));
  const last = Number.isInteger(cgp.allocation) ? cgp.allocation : 0;
  const p = await prepareVote({ w, state, node, votingContractId: contract, command: 'Allocation', ballotHex: allocationBallot(last), voterKeys: keys(), anyPhase: true });
  say(`probe: node answered, transaction ${p.hash} built, witness checked and signed (phase now: ${p.phase.phase})`);
  if (!SEND) { say('dry run: nothing published. Add --send to test that the node accepts it.'); process.exit(0); }
  say('published', await publish(node, p));
  for (let i = 0; i < 90; i++) {                         // up to 15 minutes
    await new Promise(r => setTimeout(r, 10000));
    const t = await node.request(`/blockchain/transaction?hash=${p.hash}`).catch(() => null);
    if (t && (t.confirmations > 0 || t.blockNumber)) { say('IN A BLOCK:', JSON.stringify(t).slice(0, 200)); process.exit(0); }
  }
  say('not in a block after 15 minutes (slow miner?): check again with /blockchain/transaction?hash=' + p.hash);
  process.exit(1);
}
for (;;) {
  let done = false;
  try { done = await step(); } catch (e) { say('ERROR', e.message); }
  if (ONCE) break;
  if (STOP_AFTER_VOTE && done) { say('done'); break; }
  await new Promise(r => setTimeout(r, 15000));
}
