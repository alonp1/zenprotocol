#!/usr/bin/env node
// CGP scenario on a testnet node: four test wallets with different weights nominate and vote, so every rule of the
// tally is exercised. Steps (all dry runs unless --send):
//   fund   before the snapshot block: the node wallet (TESTNET_MNEMONIC) gives each test wallet its weight
//   run    waits for the nomination and voting phases and sends every ballot (stops itself when the voting phase is over)
//   plan   prints the scenario and what the tally should show
// The CGP fund is empty until an allocation vote gives it a share of the block rewards, which starts the interval after
// the vote. So the scenario takes two intervals: in the first only the allocation is voted; in the second (the target
// interval, snapshot block --target, default the next interval's) the nominations and payout votes happen too.
// Weights are fractions of the ZP issued at the TARGET snapshot block (threshold: 3%).
//   A 1.4%   B 2.1%   C 4.2%   D 0.7%
//   nomination  A and B nominate X (together 3.5% -> passes), C nominates Y (4.2% -> passes), D nominates Z (0.7% -> fails)
//   payout vote A->X, D->X, B->Y, C->Y        Y 6.3% beats X 2.1%
//   allocation  A 5, B 10, C 15, D 0 (as far as the rules allow)
import fs from 'node:fs';
import { NodeClient } from '../src/node.js';
import { newMnemonic, deriveKey, encodeAddress } from '../src/keys.js';
import { openWallet, discover, readState, prepareVote, prepareSend, publish, receiveAddress } from '../src/wallet.js';
import { CGP_PARAMS, VOTING_CONTRACT, phaseAt, snapshotBlock, allocationBallot, payoutBallot, candidateBallot } from '../src/cgp.js';
import { ZP, formatZP, parseZP } from '../src/tx.js';

const argv = process.argv.slice(2), cmd = argv[0];
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const NET = opt('net', 'test'), SEND = argv.includes('--send');
const node = new NodeClient(opt('node', 'http://127.0.0.1:31567'));
const FILE = opt('file', new URL('./sim-wallets.json', import.meta.url).pathname);
const params = CGP_PARAMS[NET], contract = VOTING_CONTRACT[NET];
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// share of the ZP issued at the snapshot, and what each wallet does
const PEOPLE = [
  { name: 'A', share: 1.4, nominate: 'X', vote: 'X', alloc: 5 },
  { name: 'B', share: 2.1, nominate: 'X', vote: 'Y', alloc: 10 },
  { name: 'C', share: 4.2, nominate: 'Y', vote: 'Y', alloc: 15 },
  { name: 'D', share: 0.7, nominate: 'Z', vote: 'X', alloc: 0 },
];
const TARGET = Number(opt('target', 0));       // snapshot block of the interval with nominations
const intervalOfTip = tip => Math.floor(tip / params.intervalLength) + 1;
const targetSnap = tip => TARGET || snapshotBlock(params, intervalOfTip(tip) + 1);
const PAY = { X: opt('x', '1'), Y: opt('y', '2'), Z: opt('z', '0.5') };   // ZP each nominee asks from the CGP fund

const issued = snapshot => 1n + 50n * 100000000n * BigInt(snapshot - 1);       // Chain.fs genesisTotal + reward * blocks (testnet)
const share = (snapshot, pct) => issued(snapshot) * BigInt(Math.round(pct * 10)) / 1000n;

const master = () => {
  const phrase = process.env.TESTNET_MNEMONIC;
  if (!phrase) { console.error('Set TESTNET_MNEMONIC (the node wallet)'); process.exit(2); }
  return openWallet({ id: 'm', name: 'm', network: NET, kind: 'mnemonic' }, phrase);
};
const recipients = m => ({ X: encodeAddress(deriveKey(m.account, 0, 21).pkHash, NET), Y: encodeAddress(deriveKey(m.account, 0, 22).pkHash, NET), Z: encodeAddress(deriveKey(m.account, 0, 23).pkHash, NET) });
const ballotOf = (m, x) => payoutBallot(recipients(m)[x], [{ asset: ZP, amount: parseZP(PAY[x]) }]);

function plan() {
  const t = Number(opt('tip', 0)), snap = targetSnap(t), i = intervalOfTip(snap), tot = issued(snap), thr = tot * 3n / 100n;
  say(`target interval ${i}: snapshot ${snap}, nominations ${snap + 1}-${snap + params.nomination}, voting ${snap + params.nomination + 1}-${i * params.intervalLength}`);
  say(`ZP issued at the snapshot ~ ${formatZP(tot)}, threshold 3% = ${formatZP(thr)}`);
  for (const p of PEOPLE) say(`wallet ${p.name}: ${formatZP(share(snap, p.share))} ZP (${p.share}%)  nominates ${p.nominate}  votes ${p.vote}  allocation ${p.alloc}%`);
  const w = n => PEOPLE.filter(p => p.nominate === n).reduce((s, p) => s + p.share, 0);
  for (const n of 'XYZ') say(`nominee ${n} asks ${PAY[n]} ZP, weight ${w(n).toFixed(1)}% -> ${w(n) >= 3 ? 'becomes a candidate' : 'below 3%, not a candidate'}`);
  const v = n => PEOPLE.filter(p => p.vote === n).reduce((s, p) => s + p.share, 0);
  say(`payout votes: X ${v('X').toFixed(1)}%  Y ${v('Y').toFixed(1)}%  (the candidate with the most weight wins; paid at block ${i * params.intervalLength + (NET === 'main' ? 100 : 10)}, the coinbase-maturity block of the next interval)`);
}

async function fund() {
  const info = await node.info(), tip = info.blocks, snap = targetSnap(tip);
  if (tip + 3 > snap) throw new Error(`Too late: the tip is ${tip} and the target snapshot is block ${snap}.`);
  const m = master(); await discover(m, node);
  let people = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;
  if (!people || people.snapshot !== snap) {
    people = { snapshot: snap, wallets: PEOPLE.map(p => ({ name: p.name, mnemonic: newMnemonic() })) };
    fs.writeFileSync(FILE, JSON.stringify(people, null, 1), { mode: 0o600 });
    say('new test wallets saved to', FILE);
  }
  let state = await readState(m, node); const used = new Set();
  for (const p of PEOPLE) {
    const w = openWallet({ id: p.name, name: p.name, network: NET, kind: 'mnemonic' }, people.wallets.find(x => x.name === p.name).mnemonic);
    const to = receiveAddress(w);
    for (const amount of [share(snap, p.share), parseZP('1')]) {      // the weight, then a second output for the second ballot
      const st = { ...state, utxos: state.utxos.filter(u => !used.has(Buffer.from(u.outpoint.txHash).toString('hex') + ':' + u.outpoint.index)) };
      const t = prepareSend(m, st, to, amount);
      for (const inp of t.tx.inputs) used.add(Buffer.from(inp.outpoint.txHash).toString('hex') + ':' + inp.outpoint.index);
      say(`${p.name}: ${formatZP(amount)} ZP -> ${to} ${SEND ? await publish(node, t) : '(dry run)'}`);
    }
  }
  say(`funding done; it must be in a block by ${snap}. Now: node tools/cgp-sim.mjs run --send`);
}

async function run() {
  const m = master(); const people = JSON.parse(fs.readFileSync(FILE, 'utf8')); const rec = recipients(m);
  const lastInterval = intervalOfTip(people.snapshot), nomFrom = Number(opt('nominate-from', lastInterval));
  const ws = []; for (const p of PEOPLE) { const w = openWallet({ id: p.name, name: p.name, network: NET, kind: 'mnemonic' }, people.wallets.find(x => x.name === p.name).mnemonic); await discover(w, node); ws.push({ p, w, used: [], done: {} }); }
  for (;;) {
    const tip = (await node.info()).blocks, ph = phaseAt(params, tip + 1);
    say(`block ${tip}, interval ${ph.interval}, phase ${ph.phase}`);
    if (ph.interval > lastInterval) { say('the target interval is over'); return; }
    for (const x of ws) {
      const key = ph.interval + ph.phase;
      const go = async (what, command, ballotHex) => {
        if (x.done[key + what]) return;
        try {
          const state = await readState(x.w, node);
          const pr = await prepareVote({ w: x.w, state, node, votingContractId: contract, command, ballotHex, voterKeys: [...x.w.keys.values()], exclude: x.used });
          x.done[key + what] = true; x.used.push(pr.spent);
          say(`${x.p.name} ${what}: ${SEND ? 'published ' + await publish(node, pr) : 'built (dry run)'}`);
        } catch (e) { say(`${x.p.name} ${what}: ${e.message}`); }
      };
      if (ph.phase === 'Nomination' && ph.interval >= nomFrom) await go('nominates ' + x.p.nominate, 'Nomination', ballotOf(m, x.p.nominate));
      if (ph.phase === 'Vote') {
        const cgp = await node.cgp().catch(() => ({})), last = Number.isInteger(cgp.allocation) ? cgp.allocation : 0;
        const L = 100 - last, lo = Math.max(10, Math.floor(L * 85 / 100)), hi = Math.min(100, Math.floor(L * 100 / 85));   // allowed values of 100 - allocation (PROTOCOL.md 7.4)
        const ratio = Math.min(hi, Math.max(lo, 100 - x.p.alloc));
        await go(`allocation ${100 - ratio}%`, 'Allocation', allocationBallot(100 - ratio));
        if (ph.interval < nomFrom) continue;   // the fund is still empty: only the allocation is voted
        const cands = await node.candidates().catch(() => []);
        const mine = cands.find(c => c.recipient === rec[x.p.vote]);
        if (mine) await go('payout vote ' + x.p.vote, 'Payout', candidateBallot(mine)); else say(`${x.p.name}: nominee ${x.p.vote} is not a candidate (${cands.length} candidates)`);
      }
    }
    await new Promise(r => setTimeout(r, 15000));
  }
}

const fn = { plan, fund, run }[cmd];
if (!fn) { console.error('usage: cgp-sim.mjs plan|fund|run [--send] [--node URL]'); process.exit(2); }
Promise.resolve().then(fn).catch(e => { console.error('ERROR', e.message); process.exit(1); });
