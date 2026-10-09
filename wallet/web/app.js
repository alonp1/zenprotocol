// ZP Wallet - user interface. Plain DOM, no framework; every value shown that comes from a user
// or a node goes through esc(). Secrets live in memory only while unlocked.
import qrcode from 'qrcode-generator';
import { newMnemonic, checkMnemonic, isValidAddress, decodeAddress } from '../src/keys.js';
import { NodeClient, NodeError, DEFAULT_NODES } from '../src/node.js';
import { createVault, unlockVault, seal, open, storage } from '../src/vault.js';
import { CGP_PARAMS, VOTING_CONTRACT, allocationRange, allocationBallot, payoutBallot, candidateBallot, phaseAt, snapshotBlock } from '../src/cgp.js';
import { openWallet, prepareVote, checkInfo, discover, readState, readHistory, prepareSend, prepareExtend, extendCost, MAX_EXTEND_BLOCKS, publish, receiveAddress, canSpend } from '../src/wallet.js';
import { parseZP, formatZP, ZP } from '../src/tx.js';
import { hex } from '../src/serialize.js';
import contractNames from '../../site/contract-names.json';

const LOCK_AFTER_MS = 15 * 60 * 1000;
const SETTINGS_KEY = 'zp-wallet.settings.v1';
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortAddr = a => a ? a.slice(0, 10) + '…' + a.slice(-6) : '';
const ago = ms => { const s = (Date.now() - ms) / 1000; return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const icon = d => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  back: icon('<path d="M15 18l-6-6 6-6"/>'), send: icon('<path d="M7 17L17 7"/><path d="M8 7h9v9"/>'),
  recv: icon('<path d="M17 7L7 17"/><path d="M16 17H7V8"/>'), vote: icon('<path d="M9 12l2 2 4-4"/><rect x="4" y="4" width="16" height="16" rx="3"/>'),
  home: icon('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h2"/>'), gear: icon('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  doc: icon('<path d="M6 3h9l3 3v15H6z"/><path d="M9 12h6M9 16h6"/>'), refresh: icon('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  chart: icon('<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l4-5 3 3 4-6"/>'),
  copy: icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
};

// ---------------------------------------------------------------- state
const S = {
  vault: storage.load(), key: null, open: new Map(), data: new Map(),
  screen: null, tab: 'new', assetNames: {}, draft: {}, error: '', busy: false, modal: null, nodeOk: null, tip: null, cgp: null,
  settings: loadSettings(), lastActivity: Date.now(),
};
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* default */ }
  return { network: s.network === 'test' ? 'test' : 'main', nodes: { main: s.nodes?.main || DEFAULT_NODES.main[0], test: s.nodes?.test || '' }, active: s.active || null,
           voteWallets: { main: Array.isArray(s.voteWallets?.main) ? s.voteWallets.main : null, test: Array.isArray(s.voteWallets?.test) ? s.voteWallets.test : null } };
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch { /* private mode */ } }
const net = () => S.settings.network;
// a site that hosts this wallet next to its own node can name it in config.json ({ "testNode": "http://host/node" }), so its testnet works at once
const defaultNode = n => DEFAULT_NODES[n][0] || S.siteDefaults?.[n] || '';
const node = () => S.settings.nodes[net()] ? new NodeClient(S.settings.nodes[net()]) : null;
const walletsHere = () => (S.vault?.wallets || []).filter(w => w.network === net());
const active = () => { const ws = walletsHere(); return ws.find(w => w.id === S.settings.active) || ws[0] || null; };

const zpOf = id => { const z = S.data.get(id)?.state?.assets.find(x => x.asset === '00'); return z ? z.spendable + z.maturing : 0n; };
// wallets that vote together (null = every wallet that can sign); watch-only wallets cannot sign a ballot
const voters = () => { const sel = S.settings.voteWallets[net()]; return walletsHere().filter(w => w.kind !== 'watch' && (sel === null || sel.includes(w.id))); };
const voteWeight = () => voters().reduce((s, w) => s + zpOf(w.id), 0n);
const CONTRACT_ROLE = { CGP: 'Holds the community fund', VCGP: 'Counts CGP votes', FPC: 'Fixed-payout bets', 'DEX-V2': 'Exchange' };
const EXTEND_WARN = 200000000n; // 2 ZP: ask the user to check the contract once more
const nameOf = (id, addr) => contractNames[addr] || contractNames[id] || null;
const zpStr = v => Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '–';

function go(screen, extra = {}) { freshScreen = true; Object.assign(S, { screen, error: '', modal: null }, extra); if (screen === 'vote') S.cands = null; /* the candidate list belongs to one interval: ask the node again */ render(); if (screen === 'vote') refreshVotes(); window.scrollTo(0, 0); if (screen === 'markets') loadMarkets(); }
// the site that serves this node (oracle, explorer API and index files sit next to /node/)
const siteBase = () => { try { const u = new URL(S.settings.nodes[net()]); return /\/node$/.test(u.pathname) ? u.origin : ''; } catch { return ''; } };
async function loadMarkets() {
  S.marketsError = '';
  const base = siteBase();
  if (!base) { S.markets = null; S.marketsError = 'This node has no oracle or Dex next to it. Markets are on the testnet node of the community.'; return render(); }
  try {
    const get = async p => { const r = await fetch(base + p, { cache: 'no-cache' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
    const norm = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.charAt(0).toLowerCase() + k.slice(1), v]));   // the oracle answers with capitalised names
    const round = norm(await get('/oracle/rounds/latest'));
    let evidence = {}; try { evidence = JSON.parse(round.evidence || '{}'); } catch { /* older round */ }
    if (!Array.isArray(round.tickers) || !Array.isArray(round.values)) throw new Error('unexpected oracle answer');
    const orders = await get('/explorer/api/dex/orders').then(j => Array.isArray(j?.orders) ? j.orders : []).catch(() => []);
    S.markets = { round, evidence, orders, day: new Date(round.timestamp).toISOString().slice(0, 10) };
  } catch (e) { S.markets = null; S.marketsError = 'Could not read the oracle: ' + e.message; }
  render();
}

function fail(e) { S.error = e?.message || String(e); S.busy = false; render(); $app.querySelector('.modal .err, .err')?.scrollIntoView?.({ block: 'center' }); }   // the message may sit below the button that was pressed

// ---------------------------------------------------------------- views
const top = () => `<div class="top"><span class="brand">ZP Wallet</span>
  <span class="row" data-s="fixed gap6">${net() === 'test' ? '<span class="pill test">TESTNET</span>' : ''}
  <span class="pill" title="${esc(S.settings.nodes[net()])}"><span class="dot ${S.nodeOk === true ? 'ok' : S.nodeOk === false ? 'bad' : ''}"></span>${S.nodeOk === false ? 'Node offline' : S.tip ? 'Block ' + esc(S.tip.toLocaleString('en-US')) : 'Connecting…'}</span></span></div>`;
const backBar = (title, to = 'home') => `<div class="back"><button class="iconbtn" data-go="${to}" aria-label="Back">${I.back}</button><h1>${esc(title)}</h1></div>`;
const errBox = () => S.error ? `<div class="err" role="alert">${esc(S.error)}</div>` : '';
const nav = cur => `<nav class="nav">${[['home', 'Wallet', I.home], ['markets', 'Markets', I.chart], ['vote', 'Vote', I.vote], ['contracts', 'Contracts', I.doc], ['settings', 'Settings', I.gear]]
  .map(([k, l, i]) => `<button data-go="${k}" class="${cur === k ? 'on' : ''}">${i}${l}</button>`).join('')}</nav>`;

// password field with a Show/Hide button; the type is switched in place so nothing typed is lost
const pwField = (label, name, ac, extra = '') => `<label class="field">${label}<span class="pwrow"><input type="password" name="${name}" autocomplete="${ac}" ${extra}><button type="button" class="pwtoggle" data-act="toggle-pw" aria-pressed="false" aria-label="Show password">Show</button></span></label>`;

const views = {
  welcome: () => `<div class="screen" data-s="center">
    <h1 data-s="title">ZP Wallet</h1>
    <p class="muted">A wallet for the ZP network. Your recovery phrase and keys stay on this device, encrypted with a password you choose. Nobody, including the node, ever sees them.</p>
    <form data-form="create-vault" class="screen" data-s="flush">
      ${pwField('Choose a password for this device (at least 8 characters)', 'p1', 'new-password', 'required minlength="8"')}
      ${pwField('Repeat it', 'p2', 'new-password', 'required minlength="8"')}
      <div class="warn">The password only unlocks this browser. It cannot recover your coins: keep your 24 words on paper.</div>
      ${errBox()}<button class="btn primary big" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Continue'}</button>
    </form></div>`,

  unlock: () => `<div class="screen" data-s="center">
    <h1 data-s="title">ZP Wallet</h1><p class="muted">Locked. Enter your password.</p>
    <form data-form="unlock" class="screen" data-s="flush">
      ${pwField('Password', 'p', 'current-password', 'required autofocus')}
      ${errBox()}<button class="btn primary big" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Unlock'}</button>
    </form>
    <button class="btn danger" data-act="reset">Forgot password: remove wallets from this browser</button></div>`,

  add: () => {
    const t = S.tab, importing = t !== 'new', subs = [['phrase', 'Recovery phrase'], ['key', 'Private key'], ['watch', 'Watch only']];
    let body = '';
    if (t === 'new') {
      S.draft.words ||= newMnemonic().split(' ');
      body = `<p class="muted small">Write these 24 words on paper, in order. They are the only backup of this wallet.</p>
        <div class="words">${S.draft.words.map((w, i) => `<div><span>${i + 1}</span>${esc(w)}</div>`).join('')}</div>
        <label class="row small" data-s="gap10"><input type="checkbox" name="saved" required data-s="check"> I wrote the words down</label>`;
    } else if (t === 'phrase') body = `<label class="field">Recovery phrase (24 words, any wallet for the ZP network)<textarea name="words" autocomplete="off" spellcheck="false" required></textarea></label>`;
    else if (t === 'key') body = `<label class="field">Private key (64 hex characters or an extended key)<textarea name="key" autocomplete="off" spellcheck="false" required></textarea></label>`;
    else body = `<label class="field">Address to watch (balance only, no spending)<input name="addr" class="mono" placeholder="${net() === 'main' ? 'zen1q…' : 'tzn1q…'}" required></label>`;
    return `${backBar('Add a wallet', walletsHere().length ? 'home' : 'add')}<form data-form="add-wallet" class="screen">
      <div class="seg" role="tablist">
        <button type="button" class="chip big ${!importing ? 'on' : ''}" data-tab="new" role="tab" aria-selected="${!importing}"><b>New wallet</b><span>Create a fresh wallet</span></button>
        <button type="button" class="chip big ${importing ? 'on' : ''}" data-tab="${importing ? t : 'phrase'}" role="tab" aria-selected="${importing}"><b>Import existing</b><span>I already have a wallet</span></button></div>
      ${importing ? `<p class="muted small">What do you have?</p><div class="tabs3">${subs.map(([k, l]) => `<button type="button" class="chip ${k === t ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>` : ''}
      <label class="field">Name<input name="name" maxlength="40" value="${esc(S.draft.name || ['Main', 'Mining', 'Savings', 'Test'][walletsHere().length] || 'Wallet ' + (walletsHere().length + 1))}"></label>
      ${body}
      ${t !== 'watch' && t !== 'new' ? '<div class="warn">Only type your words or key on your own device. Nobody from the community will ever ask for them.</div>' : ''}
      <p class="muted small">Network: <b>${net() === 'main' ? 'Mainnet' : 'Testnet'}</b> (change in Settings).</p>
      ${errBox()}<button class="btn primary big" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : importing ? 'Import wallet' : 'Create wallet'}</button></form>`;
  },

  home: () => {
    const ws = walletsHere(), a = active();
    if (!a) return `${top()}<div class="screen"><p class="muted">No ${net() === 'test' ? 'testnet ' : ''}wallet yet.</p><button class="btn primary big" data-go="add">Add a wallet</button></div>${nav('home')}`;
    const d = S.data.get(a.id) || {}, zp = d.state?.assets.find(x => x.asset === '00');
    const total = ws.reduce((s, w) => s + (S.data.get(w.id)?.state?.assets.find(x => x.asset === '00')?.spendable || 0n)
      + (S.data.get(w.id)?.state?.assets.find(x => x.asset === '00')?.maturing || 0n), 0n);
    const others = (d.state?.assets || []).filter(x => x.asset !== '00');
    const c = cgpInfo();
    return `${top()}<div class="screen">
      <div class="wallets" role="tablist">${ws.map(w => `<button class="chip ${w.id === a.id ? 'on' : ''}" data-wallet="${esc(w.id)}" role="tab">${esc(w.name)}${w.kind === 'watch' ? ' 👁' : ''}</button>`).join('')}
        <button class="chip" data-go="add" aria-label="Add a wallet">+ Add</button></div>
      <div><div class="muted small">${esc(a.name)}${ws.length > 1 ? ` · all wallets ${formatZP(total)} ZP` : ''}</div>
        <div class="balance">${d.state ? formatZP(zp?.spendable || 0n) : '…'} <small>ZP</small></div>
        ${zp?.maturing ? `<div class="muted small">${formatZP(zp.maturing)} ZP mining rewards maturing · spendable from block ${zp.maturesAt.toLocaleString('en-US')}</div>` : ''}
        ${d.error ? `<div class="err small">${esc(d.error)}</div>` : ''}</div>
      <div class="actions">
        <button class="btn primary" data-go="send" ${canSpend(S.open.get(a.id)) ? '' : 'disabled'}>${I.send}Send</button>
        <button class="btn" data-go="receive">${I.recv}Receive</button>
        <button class="btn" data-go="vote">${I.vote}Vote</button></div>
      ${c ? `<button class="card cgp" data-go="vote" data-s="plain">
        <div class="row k"><span>CGP · INTERVAL ${c.community}</span><span data-s="right">${esc(c.phase)}</span></div>
        <div data-s="mt4">${esc(c.next)} in ${c.blocksLeft.toLocaleString('en-US')} blocks · around ${esc(c.eta)}</div>
        <div class="muted small">Fund ${cgpBalance()} · ${zpStr(c.cgpPerBlock)} ZP per block to the CGP · your vote weight ${formatZP(voteWeight())} ZP</div></button>` : ''}
      ${others.length ? `<div class="card"><h2>Tokens</h2><div class="list">${others.map(x => `<div class="item"><span title="${esc(x.asset)}">${S.assetNames[x.asset] ? esc(S.assetNames[x.asset]) : `<span class="mono small">${esc(x.asset.slice(0, 18))}…</span>`}</span><span class="amt">${formatZP(x.spendable + x.maturing)}</span></div>`).join('')}</div></div>` : ''}
      <div class="row"><h2>Activity</h2><button class="iconbtn" data-act="refresh" aria-label="Refresh" data-s="fixed">${S.busy ? '<span class="spin"></span>' : I.refresh}</button></div>
      <div class="list">${!d.history ? '<p class="muted small">Loading…</p>' : d.history.length === 0 ? '<p class="muted small">No transactions yet.</p>' : d.history.map(h => {
        const amt = BigInt(h.amount), inn = amt > 0n;
        const what = h.lock?.Coinbase ? 'Mining reward' : inn ? 'Received' : 'Sent';
        return `<div class="item"><div><div>${what}</div><div class="muted small">${h.timestamp ? ago(h.timestamp) : 'pending'} · ${h.confirmations ? esc(h.confirmations.toLocaleString('en-US')) + ' conf.' : 'unconfirmed'}</div></div>
          <div class="amt ${inn ? 'in' : ''}">${inn ? '+' : '−'}${h.asset === '00' ? formatZP(inn ? amt : -amt) + ' ZP' : esc(String(inn ? amt : -amt))}</div></div>`;
      }).join('')}</div></div>${nav('home')}`;
  },

  send: () => {
    const a = active(), zp = S.data.get(a.id)?.state?.assets.find(x => x.asset === '00');
    return `${backBar('Send ZP')}<form data-form="send" class="screen">
      <label class="field">To address<input name="to" class="mono" autocomplete="off" spellcheck="false" placeholder="${net() === 'main' ? 'zen1q…' : 'tzn1q…'}" value="${esc(S.draft.to || '')}" required></label>
      <label class="field"><span class="row" data-s="between"><span>Amount (ZP)</span><span data-s="right">Available ${formatZP(zp?.spendable || 0n)}</span></span>
        <span class="row"><input name="amount" inputmode="decimal" autocomplete="off" value="${esc(S.draft.amount || '')}" required><button type="button" class="btn" data-act="max" data-s="fixed">Max</button></span></label>
      <div class="card small"><div class="kv"><span class="muted">From</span><span>${esc(a.name)}</span></div><div class="kv"><span class="muted">Network fee</span><span>None</span></div><div class="kv"><span class="muted">Change returns to</span><span class="mono">${esc(shortAddr(receiveAddress(S.open.get(a.id))))}</span></div></div>
      <p class="muted small">Signed on this device. The node only receives the signed transaction.</p>
      ${errBox()}<button class="btn primary big">Review</button></form>`;
  },

  receive: () => {
    const a = active(), addr = receiveAddress(S.open.get(a.id));
    const q = qrcode(0, 'M'); q.addData(addr); q.make();
    return `${backBar('Receive')}<div class="screen" data-s="stretch">
      <div class="qr">${q.createSvgTag({ cellSize: 5, margin: 2, scalable: false })}</div>
      <div class="card"><div class="muted small">${esc(a.name)} · ${net() === 'main' ? 'Mainnet' : 'Testnet'}</div><div class="addr"><b>${esc(addr.slice(0, 9))}</b>${esc(addr.slice(9, -6))}<b>${esc(addr.slice(-6))}</b></div></div>
      <button class="btn primary big" data-act="copy" data-text="${esc(addr)}">${I.copy}Copy address</button>
      <p class="muted small">Check the first and last characters with the sender. Mining rewards to this address unlock after 100 blocks.</p></div>`;
  },

  vote: () => {
    const c = cgpInfo(), sel = new Set(voters().map(w => w.id)), signers = walletsHere().filter(w => w.kind !== 'watch');
    return `${top()}<div class="screen"><h1>CGP vote</h1>
      ${c ? `<div class="card cgp"><div class="row k"><span>INTERVAL ${c.community} <span class="muted">(node ${c.interval})</span></span><span data-s="right">${esc(c.phase)}</span></div>
        <div data-s="mt6">${esc(c.next)} in ${c.blocksLeft.toLocaleString('en-US')} blocks · around ${esc(c.eta)}</div>
        <div class="kv" data-s="mt6"><span class="muted">To the CGP</span><span>${zpStr(c.cgpPerBlock)} ZP / block (${alloc()}%)</span></div>
        <div class="kv"><span class="muted">CGP fund</span><span title="${esc(S.stats?.cgp?.balance ? 'at block ' + S.stats.cgp.balance.block : '')}">${cgpBalance()}</span></div>
        <div class="kv"><span class="muted">Snapshot block</span><span>${c.snapshot.toLocaleString('en-US')}</span></div></div>` : S.nodeOk === false ? `<div class="err" role="alert">Cannot reach the node (${esc(S.nodeError || 'no answer')}). The vote needs a node: check the address in Settings, then try again.</div><button class="btn" data-act="refresh">Try again</button>` : '<p class="muted">Loading…</p>'}
      <div class="card"><h2>Wallets that vote</h2>
        <p class="muted small">Choose one wallet or several: their balances at the snapshot block add up to one vote weight.</p>
        <div class="list">${signers.map(w => `<button class="item" data-act="vote-toggle" data-id="${esc(w.id)}" data-s="plain" aria-pressed="${sel.has(w.id)}">
          <span class="row"><span class="check ${sel.has(w.id) ? 'on' : ''}" aria-hidden="true">${sel.has(w.id) ? '✓' : ''}</span><span>${esc(w.name)}</span></span>
          <span class="amt" data-s="fixed">${formatZP(zpOf(w.id))} ZP</span></button>`).join('') || '<p class="muted small">Add a wallet with its 24 words or key to vote. Watch-only wallets cannot sign a ballot.</p>'}</div>
        ${signers.length > 1 ? `<div class="row" data-s="mt10"><button class="btn" data-act="vote-all">All</button><button class="btn" data-act="vote-none">None</button></div>` : ''}
        <div class="kv" data-s="mt10"><span>Vote weight now</span><span class="amt">${formatZP(voteWeight())} ZP</span></div></div>
      ${ballotsCard(c)}${sentCard(c)}
      <div class="card"><h2>Protocol upgrade vote</h2><p class="muted small">Inactive: the Repo voting contract has been inactive since block 233,874.</p></div></div>${nav('vote')}`;
  },

  markets: () => {
    const m = S.markets, base = siteBase();
    const unit = (asset, v) => { const big = BigInt(v); return asset === '00' ? formatZP(big) + ' ZP' : (S.assetNames[asset] === 'zUSDC' ? (Number(big) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' zUSDC' : big.toString() + ' ' + (S.assetNames[asset] || shortAddr(asset))); };
    const rows = (m?.round?.tickers || []).map((t, i) => {
      const e = m.evidence[t] || {}, names = Object.keys(e.sources || {}), dropped = e.dropped || [];
      const src = !names.length ? '1 source' : `${names.length - dropped.length} of ${names.length} agree${dropped.length ? ' · dropped ' + dropped.join(', ') : ''}`;
      const day = e.asOf && m.day && e.asOf !== m.day ? 'close ' + e.asOf : '';
      const tip = names.map(n => n + ' = ' + e.sources[n]).join('\n');
      return `<div class="item" title="${esc(tip)}"><div><div><b>${esc(t)}</b></div><div class="muted small">${esc(src)}${day ? ' · ' + esc(day) : ''}</div></div><div class="amt">${esc(Number(m.round.values[i]).toLocaleString('en-US', { maximumFractionDigits: 6 }))}</div></div>`;
    }).join('');
    const orders = (m?.orders || []).slice(0, 12).map(o => {
      let text = '';
      try { text = `${unit(o.under_asset, o.under_amount)} for ${unit(o.pair_asset, o.pair_total)}`; } catch { text = 'order'; }
      return `<div class="item"><div><div>${esc(text)}</div><div class="muted small mono" title="${esc(o.maker || '')}">${esc(shortAddr(String(o.maker || '')))}</div></div></div>`;
    }).join('');
    return `${top()}<div class="screen"><h1>Markets</h1>
      ${S.marketsError ? `<div class="card"><p class="muted small">${esc(S.marketsError)}</p></div>` : ''}
      <div class="card"><h2>Oracle prices (USD)${m?.round ? ' · ' + esc(ago(m.round.timestamp)) : ''}</h2><div class="list">${!m && !S.marketsError ? '<p class="muted small">Loading…</p>' : rows || '<p class="muted small">No prices yet.</p>'}</div></div>
      <div class="card"><h2>Dex orders</h2><div class="list">${!m && !S.marketsError ? '<p class="muted small">Loading…</p>' : orders || '<p class="muted small">No open orders.</p>'}</div></div>
      <div class="card"><p class="muted small">Prices come from the community oracle: several sources must agree, stocks and gold are end-of-day closes. Trading from the wallet arrives in the next version. Today use <a href="${esc(base)}/dex.html" rel="noopener">the Dex page</a>.</p></div></div>${nav('markets')}`;
  },

  contracts: () => {
    const cs = S.contracts, wa = active(), mayExtend = !!(wa && S.open.get(wa.id) && canSpend(S.open.get(wa.id)));
    return `${top()}<div class="screen"><h1>Smart contracts</h1>
    <div class="card"><h2>Active contracts</h2><div class="list">${!cs ? '<p class="muted small">Loading…</p>' : cs.length === 0 ? '<p class="muted small">None.</p>' : cs.map((k, i) => {
      const left = k.expire - (S.tip || k.expire), cls = left < 300 ? 'lvl-bad' : left < 3000 ? 'lvl-warn' : '';
      return `<div class="item"><div><div>${esc(k.name || 'Unnamed')}</div><div class="muted small mono" title="${esc(k.address)}">${esc(shortAddr(k.address))}</div></div>
        <div data-s="right"><div class="small">until ${Number(k.expire).toLocaleString('en-US')}</div><div class="small ${cls}">${left.toLocaleString('en-US')} blocks left</div>${mayExtend ? `<button class="btn small" data-act="extend" data-i="${i}">Extend</button>` : ''}</div></div>`;
    }).join('')}</div></div>
    <div class="card"><p class="muted small">Tokens issued by contracts appear on the Wallet screen. Extending a contract keeps it running past its end block: it costs ZP from the active wallet. Viewing code and running contracts arrive in a later version.</p></div></div>${nav('contracts')}`;
  },

  settings: () => `${top()}<div class="screen"><h1>Settings</h1>
    <div class="card"><h2>Network</h2><div class="tabs" data-s="two mt10">
      <button class="chip ${net() === 'main' ? 'on' : ''}" data-net="main">Mainnet</button><button class="chip ${net() === 'test' ? 'on' : ''}" data-net="test">Testnet</button></div>
      ${net() === 'test' ? '<p class="small" data-s="amber">Testnet coins have no value. Testnet wallets are kept apart from mainnet wallets.</p>' : ''}</div>
    <form class="card" data-form="node"><h2>Node</h2>
      <label class="field" data-s="mt10">Node address for ${net() === 'main' ? 'mainnet' : 'testnet'}
        <input name="url" class="mono" value="${esc(S.settings.nodes[net()])}" placeholder="https://… or http://localhost:11567"></label>
      <div class="row" data-s="mt10"><button class="btn primary">Save and test</button><button type="button" class="btn" data-act="node-default">Default</button></div>
      <p class="muted small">${esc(defaultNode(net()) ? 'Default: ' + defaultNode(net()) : 'No public testnet node yet: run your own or enter one.')}</p></form>
    <div class="card"><h2>Wallets on ${net() === 'main' ? 'mainnet' : 'testnet'}</h2><div class="list">${walletsHere().map(w => `<div class="item"><div><div>${esc(w.name)}</div><div class="muted small">${{ mnemonic: '24 words', key: 'Private key', watch: 'Watch only' }[w.kind]}</div></div>
      <span class="row" data-s="fixed">${w.kind !== 'watch' ? `<button class="btn" data-act="reveal" data-id="${esc(w.id)}">Backup</button>` : ''}<button class="btn danger" data-act="remove" data-id="${esc(w.id)}">Remove</button></span></div>`).join('') || '<p class="muted small">None.</p>'}</div></div>
    <button class="btn big" data-act="lock">Lock now</button>
    <p class="muted small">ZP Wallet is open source and community-run. Not affiliated with Zen Protocol Ltd.</p></div>${nav('settings')}`,
};

const alloc = () => { const a = S.cgp?.allocation; return Number.isInteger(a) && a >= 0 && a <= 100 ? a : 90; };

// CGP cycle seen from the next block (the one a ballot sent now would land in); intervals per network from cgp.js
function cgpInfo() {
  if (!S.tip) return null;
  const p = CGP_PARAMS[net()], tip = S.tip, ph = phaseAt(p, tip + 1), interval = ph.interval, snap = snapshotBlock(p, interval);
  const [phase, next, at] = ph.phase === 'before' ? ['Before snapshot', 'Balance snapshot', snap] : ph.phase === 'Nomination' ? ['Nomination', 'Voting opens', ph.closes] : ['Voting', 'Voting closes', ph.closes];
  const eta = new Date(Date.now() + (at - tip) * 236682).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const reward = 50 / 2 ** Math.floor(Math.max(0, tip - 2) / 800000);       // ZP per block, halving every 800,000 blocks
  // wallets and the explorer number intervals from the CGP launch (node interval 106 = interval 82)
  return { interval, community: net() === 'test' ? interval : interval - 24, phase, next, blocksLeft: at - tip, eta, snapshot: snap, reward, cgpPerBlock: reward * alloc() / 100 };
}
const cgpBalance = (withBlock = false) => {
  const b = S.stats?.cgp?.balance;
  return b && Number.isFinite(b.zp) ? zpStr(b.zp) + ' ZP' + (withBlock ? ` <span class="muted small">at block ${Number(b.block).toLocaleString('en-US')}</span>` : '') : 'not available from this node';
};

// ---------------------------------------------------------------- CGP ballots
function ballotsCard(c) {
  if (!c) return '';
  const ph = phaseAt(CGP_PARAMS[net()], (S.tip || 0) + 1), none = !voters().length;
  const note = none ? '<p class="muted small">Select at least one wallet that can sign above.</p>' : '';
  if (ph.phase === 'before') return `<div class="card"><h2>Casting ballots</h2><p class="muted small">Ballots open after the snapshot block (${c.snapshot.toLocaleString('en-US')}). Your balance at that block is your weight for this interval.</p></div>`;
  const cur = alloc(), r = allocationRange(CGP_PARAMS[net()], cur), many = r.max - r.min > 5;
  const values = many ? [...new Set([r.min, cur, r.max])] : Array.from({ length: r.max - r.min + 1 }, (_, i) => r.min + i);
  const pct0 = S.draft.pct || String(cur);
  const allocForm = `<form data-form="vote-alloc" class="screen" data-s="flush"><h2>Allocation vote</h2>
      <p class="muted small">Share of each block reward paid to the CGP fund; the miners get the rest. Counted in the voting phase. With ${cur}% in force the valid votes are ${r.min}% to ${r.max}%: anything else is ignored.</p>
      <div class="cmp"><div><div class="k">Now in force</div><div class="v">CGP ${cur}%</div><div class="muted small">miners ${100 - cur}%</div></div>
        <div class="arrow" aria-hidden="true">→</div>
        <div><div class="k">Your vote</div><div class="v" id="alloc-v">CGP ${esc(pct0)}%</div><div class="muted small" id="alloc-m"></div></div></div>
      <div class="tabs3" role="group" aria-label="Choose a value">${values.map(v => `<button type="button" class="chip ${String(v) === pct0 ? 'on' : ''}" data-act="alloc-pick" data-v="${v}">${v}%${v === cur ? '<br><span class="muted small">keep</span>' : ''}</button>`).join('')}</div>
      ${many ? `<input type="range" class="slider" name="pctr" min="${r.min}" max="${r.max}" step="1" value="${esc(pct0)}" aria-label="Allocation (%)">` : ''}
      <label class="field">Allocation (%)<input name="pct" inputmode="numeric" autocomplete="off" value="${esc(pct0)}" data-min="${r.min}" data-max="${r.max}" data-cur="${cur}" required></label>
      <div class="small" id="alloc-note" aria-live="polite"></div>
      ${ph.phase === 'Vote' ? `<button class="btn primary" id="alloc-go" ${none ? 'disabled' : ''}>Review</button>` : '<p class="muted small">Opens with the voting phase.</p>'}</form>`;
  const fundZp = S.stats?.cgp?.balance && Number.isFinite(S.stats.cgp.balance.zp) ? S.stats.cgp.balance.zp : null;
  const mine = walletsHere().map(w => ({ name: w.name, addr: receiveAddress(S.open.get(w.id)) })).filter(x => x.addr);
  const nom = `<form data-form="vote-nom" class="screen" data-s="flush"><h2>Payout nomination</h2>
      <p class="muted small">Propose that the CGP fund pays an amount of ZP to an address. Needs 3% of all ZP behind it to become a candidate.</p>
      <label class="field">Recipient address<input name="to" class="mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${net() === 'main' ? 'zen1q…' : 'tzn1q…'}" value="${esc(S.draft.nto || '')}" required></label>
      <div class="row wrapchips"><button type="button" class="chip" data-act="paste-to">Paste</button>${mine.map(x => `<button type="button" class="chip" data-act="use-addr" data-addr="${esc(x.addr)}" title="${esc(x.addr)}">${esc(x.name)}</button>`).join('')}</div>
      <div class="small" id="to-note" aria-live="polite"></div>
      <label class="field">Amount (ZP)<input name="amount" inputmode="decimal" autocomplete="off" value="${esc(S.draft.namount || '')}" data-fund="${fundZp === null ? '' : fundZp}" required></label>
      <div class="small muted" id="amt-note" aria-live="polite">${fundZp === null ? '' : `The CGP fund holds ${zpStr(fundZp)} ZP: a larger request cannot be paid.`}</div>
      ${ph.phase === 'Nomination' ? `<button class="btn primary" ${none ? 'disabled' : ''}>Review</button>` : '<p class="muted small">Opens in the nomination phase.</p>'}</form>`;
  const cands = S.cands ? (S.cands.length ? S.cands.map((x, i) => `<button class="item" data-act="vote-cand" data-i="${i}" data-s="plain" ${ph.phase === 'Vote' && !none ? '' : 'disabled'}>
      <span class="mono small" data-s="wrap">${esc(x.recipient)}</span><span class="amt">${x.spendlist.map(s => s.asset === '00' ? formatZP(BigInt(s.amount)) + ' ZP' : 'asset ' + esc(s.asset.slice(0, 8)) + '…').join(' + ')}</span></button>`).join('') : '<p class="muted small">No candidates in this interval.</p>')
    : `<button class="btn" data-act="load-cands">Show candidates</button>`;
  return `<div class="card"><h2>Casting ballots</h2>
    <p class="muted small">Signed on this device by the selected wallets; each sends one transaction with a 1 kalapa fee. Only the first vote of each key counts in a phase.</p>${note}
    <div class="card">${allocForm}</div><div class="card">${nom}</div>
    <div class="card"><h2>Payout vote</h2><p class="muted small">Pick a candidate. Counted in the voting phase.</p><div class="list">${cands}</div></div>${errBox()}</div>`;
}
async function reviewVote(kind, command, ballotHex, label, rows = []) {
  const sel = voters(); if (!sel.length) throw new Error('Select at least one wallet that can sign');
  const funder = S.open.get(active().id) && canSpend(S.open.get(active().id)) && sel.some(w => w.id === active().id) ? active() : sel[0];
  await refreshWallet(funder.id);
  const d = S.data.get(funder.id); if (!d?.state) throw new Error('Could not read the balance from the node');
  const voterKeys = sel.flatMap(w => [...S.open.get(w.id).keys.values()]);
  // an output spent by a vote that is not in a block yet still shows as unspent: do not use it twice
  const now = Date.now(), here = new Set(d.state.utxos.map(u => hex(u.outpoint.txHash) + ':' + u.outpoint.index));
  S.pendingVotes = (S.pendingVotes || []).filter(p => now - p.at < 30 * 60 * 1000 && here.has(p.spent));
  const exclude = S.pendingVotes.map(p => p.spent);
  let prepared;
  try { prepared = await prepareVote({ w: S.open.get(funder.id), state: d.state, node: node(), votingContractId: VOTING_CONTRACT[net()], command, ballotHex, voterKeys, exclude }); }
  catch (e) {
    if (exclude.length && /little ZP/.test(e.message)) throw new Error('Your last vote is still waiting for its block (about 4 minutes). Wait for it, then send the next one.');
    throw e;
  }
  S.modal = { type: 'confirm-vote', kind, label, rows, prepared, weight: voteWeight() }; S.error = ''; render();
}

// ---------------------------------------------------------------- modal
function modalHtml() {
  const m = S.modal; if (!m) return '';
  if (m.type === 'confirm-send') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Confirm transfer</h2>
    <div class="card"><div class="kv"><span class="muted">Send</span><span class="amt">${formatZP(m.amount)} ZP</span></div>
    <div class="kv"><span class="muted">To</span><span class="mono small">${esc(m.to)}</span></div>
    <div class="kv"><span class="muted">From</span><span>${esc(active().name)}</span></div>
    <div class="kv"><span class="muted">Fee</span><span>None</span></div></div>
    <p class="muted small">Transfers cannot be reversed. Check the address.</p>${errBox()}
    <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="confirm-send" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Sign and send'}</button></div></div></div>`;
  if (m.type === 'confirm-vote') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Confirm ${esc(m.kind)}</h2>
    <div class="card"><div class="kv"><span class="muted">Ballot</span><span>${esc(m.label)}</span></div>
    ${(m.rows || []).map(([k, v, mono]) => `<div class="kv"><span class="muted">${esc(k)}</span><span class="${mono ? 'mono small' : ''}">${esc(v)}</span></div>`).join('')}
    <div class="kv"><span class="muted">Signing keys</span><span>${m.prepared.signers}</span></div>
    <div class="kv"><span class="muted">Weight (balance at snapshot)</span><span>about ${formatZP(m.weight)} ZP</span></div>
    <div class="kv"><span class="muted">Fee</span><span>1 kalapa</span></div></div>
    <p class="muted small">Interval ${m.prepared.phase.interval}, ${esc(m.prepared.phase.phase)} phase. A vote cannot be changed after it is sent.</p>${errBox()}
    <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="confirm-vote" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Sign and send'}</button></div></div></div>`;
  if (m.type === 'voted') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2 class="ok">✓ Broadcast successfully</h2>
    <p>The node accepted your ${esc(m.kind)}: <b>${esc(m.label)}</b>.</p>
    <p class="muted small">It counts once it is in a block of this phase (about 4 minutes). Its status is under “Your ballots” on this screen.</p>
    <div class="card small"><div class="muted">Transaction</div><div class="mono" data-s="wrap">${esc(m.hash)}</div></div>
    <button class="btn primary big" data-act="close">Done</button></div></div>`;
  if (m.type === 'extend') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Extend ${esc(m.name || 'contract')}</h2>
    <form data-form="extend" class="screen" data-s="flush">
    <div class="card"><div class="kv"><span class="muted">Ends at block</span><span>${m.expire.toLocaleString('en-US')}</span></div>
    <div class="kv"><span class="muted">Blocks left</span><span>${Math.max(0, m.expire - (S.tip || m.expire)).toLocaleString('en-US')}</span></div>
    <div class="kv"><span class="muted">Price</span><span>${m.code.length.toLocaleString('en-US')} kalapas per block</span></div>
    <div class="kv"><span class="muted">Your balance</span><span>${m.balance === null ? '–' : formatZP(m.balance) + ' ZP'}</span></div></div>
    <label class="field">Extend by (blocks)<input name="blocks" inputmode="numeric" autocomplete="off" value="${esc(m.blocks || '')}" required></label>
    <div class="wrapchips">${extendPresets().map(([b, t]) => `<button type="button" class="chip" data-act="ext-pick" data-v="${b}" title="${formatZP(extendCost(m.code, b))} ZP">${esc(t)} · ${zpStr(Number(extendCost(m.code, b)) / 1e8)} ZP</button>`).join('')}</div>
    <div class="card"><div class="kv"><span class="muted">Cost</span><span id="ext-cost">–</span></div>
    <div class="kv"><span class="muted">New end block</span><span id="ext-new">–</span></div></div>
    <p id="ext-note" class="small muted"></p>${errBox()}
    <div class="row"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" id="ext-go" disabled>Review</button></div></form></div></div>`;
  if (m.type === 'confirm-extend') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Confirm extension</h2>
    <div class="card"><div class="kv"><span class="muted">Contract</span><span>${esc(m.name || 'Unnamed')}</span></div>
    ${CONTRACT_ROLE[m.name] ? `<div class="kv"><span class="muted">What it does</span><span>${esc(CONTRACT_ROLE[m.name])}</span></div>` : ''}
    <div class="kv"><span class="muted">Contract ID</span><span class="mono">${esc(m.id.slice(0, 12))}…${esc(m.id.slice(-8))}</span></div>
    <div class="kv"><span class="muted">Extend by</span><span>${m.blocks.toLocaleString('en-US')} blocks${net() === 'main' ? ` (${m.blocks < 365 ? 'less than a day' : 'about ' + (m.blocks / 365).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' days'})` : ''}</span></div>
    <div class="kv"><span class="muted">Cost</span><span class="amt">${formatZP(m.prepared.cost)} ZP</span></div>
    <div class="kv"><span class="muted">New end block</span><span>${(m.expire + m.blocks - 1).toLocaleString('en-US')}</span></div>
    <div class="kv"><span class="muted">From</span><span>${esc(active().name)}</span></div></div>
    ${m.prepared.cost >= EXTEND_WARN ? `<p class="bad small">This is a large payment: ${formatZP(m.prepared.cost)} ZP. Each block costs ${m.code.length.toLocaleString('en-US')} kalapas because this contract's code is that long. Check that this is the contract you meant.</p>` : ''}
    <p class="muted small">The ZP is spent for good: it is not returned if the contract is not used.</p>${errBox()}
    <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="confirm-extend" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Sign and send'}</button></div></div></div>`;
  if (m.type === 'extended') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2 class="ok">✓ Broadcast successfully</h2>
    <p>The node accepted the extension of <b>${esc(m.name || 'the contract')}</b> by ${m.blocks.toLocaleString('en-US')} blocks.</p>
    <p class="muted small">It takes effect when the transaction is in a block (about 4 minutes). The new end block then shows on this screen.</p>
    <div class="card small"><div class="muted">Transaction</div><div class="mono" data-s="wrap">${esc(m.hash)}</div></div>
    <button class="btn primary big" data-act="close">Done</button></div></div>`;
  if (m.type === 'sent') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2 class="ok">Sent</h2>
    <p>${formatZP(m.amount)} ZP is on its way. It appears in the next block, about 4 minutes.</p>
    <div class="card small"><div class="muted">Transaction</div><div class="mono" data-s="wrap">${esc(m.hash)}</div></div>
    <button class="btn primary big" data-act="close">Done</button></div></div>`;
  if (m.type === 'reveal') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>Backup · ${esc(m.name)}</h2>
    ${m.secret ? `${m.kind === 'mnemonic' ? `<div class="words">${m.secret.split(' ').map((w, i) => `<div><span>${i + 1}</span>${esc(w)}</div>`).join('')}</div>` : `<div class="card mono small" data-s="wrap">${esc(m.secret)}</div>`}
      <div class="warn">Anyone with this can take the coins. Never send it to anyone or share it in a screenshot.</div>`
    : `<form data-form="reveal" class="screen" data-s="flush">${pwField('Password', 'p', 'current-password', 'required autofocus')}${errBox()}<button class="btn primary">Show</button></form>`}
    <button class="btn" data-act="close">Close</button></div></div>`;
  if (m.type === 'confirm') return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet"><h2>${esc(m.title)}</h2><p>${esc(m.text)}</p>
    <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn danger" data-act="${esc(m.act)}" data-id="${esc(m.id || '')}">${esc(m.ok)}</button></div></div></div>`;
  return '';
}

// Background refreshes re-render the page: what the person has typed (password, 24 words, an amount) must survive that.
let freshScreen = true;
const fieldKey = el => (el.form?.dataset.form || '') + '/' + el.name;
function snapshotFields() {
  return [...$app.querySelectorAll('form[data-form] input, form[data-form] textarea')].filter(el => el.name && el.type !== 'hidden')
    .map(el => ({ key: fieldKey(el), box: el.type === 'checkbox', value: el.type === 'checkbox' ? el.checked : el.value, focus: el === document.activeElement,
                  from: el.selectionStart, to: el.selectionEnd, type: el.type }));
}
function render() {
  const saved = freshScreen ? [] : snapshotFields();
  freshScreen = false;
  const v = views[S.screen] || views.welcome;
  $app.innerHTML = v() + modalHtml();
  const f = $app.querySelector('[autofocus]'); if (f) f.focus();
  if (S.screen === 'vote') { const p = $app.querySelector('input[name=pct]'); if (p) syncAlloc(p.value, 'field'); syncTo(); syncAmt(); }
  if (S.screen === 'vote' && S.error && !S.modal) $app.querySelector('.err')?.scrollIntoView({ block: 'center' });   // the message sits below three forms: a phone screen would not show it
  for (const s of saved) {
    const el = [...$app.querySelectorAll('form[data-form] input, form[data-form] textarea')].find(e => e.name && fieldKey(e) === s.key);
    if (!el) continue;
    if (s.box) el.checked = s.value; else if (el.value !== s.value) el.value = s.value;
    if (s.focus) { el.focus(); try { el.setSelectionRange(s.from, s.to); } catch { /* checkbox */ } }
  }
}

// ---------------------------------------------------------------- data
async function refreshNode() {
  const n = node();
  if (!n) { S.nodeOk = false; S.tip = null; return; }
  // A node that is busy (it serves the chain indexer too) can miss one request: ask up to 3 times before saying "offline".
  // A wrong network or a bad answer is not retried.
  for (let i = 0; i < 3; i++) {
    try { const info = checkInfo(await n.info(), net()); S.tip = info.blocks; S.nodeOk = true; S.nodeError = ''; S.cgp = await n.cgp().catch(() => null); break; }
    catch (e) {
      S.nodeOk = false; S.nodeError = e.message;
      if (!(e instanceof NodeError) || i === 2) break;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  refreshExtras().then(render);        // names, stats and contracts are shown when they arrive: the balance does not wait for them
}
async function refreshExtras() {
  const n = node(); if (!n) return;
  // the community site publishes stats.json next to /node/ (CGP fund balance, named contracts)
  S.stats = null;
  try {
    const u = new URL(S.settings.nodes[net()]);
    if (/\/node$/.test(u.pathname)) {
      const r = await fetch(u.origin + '/stats.json', { cache: 'no-cache' });
      if (r.ok) { const j = await r.json(); if (j && typeof j === 'object') S.stats = j; }
      const ra = await fetch(u.origin + '/assets.json', { cache: 'no-cache' });
      if (ra.ok) {
        const j = await ra.json(), names = {};
        for (const x of Array.isArray(j?.assets) ? j.assets : []) if (typeof x?.asset === 'string' && typeof x?.name === 'string') names[x.asset] = x.name.slice(0, 40);
        S.assetNames = names;
      }
    }
  } catch { /* optional */ }
  const list = Array.isArray(S.stats?.contracts) ? S.stats.contracts : await n.activeContracts().catch(() => null);
  S.contracts = Array.isArray(list) ? list
    .map(c => ({ id: String(c.id ?? c.contractId ?? ''), address: String(c.address ?? ''), expire: Number(c.expire) }))
    .filter(c => Number.isSafeInteger(c.expire) && /^c(zen|tzn)1[0-9a-z]+$/.test(c.address))
    .map(c => ({ ...c, name: nameOf(c.id, c.address) }))
    .sort((x, y) => x.expire - y.expire) : null;
}
async function refreshWallet(id, full, onState) {
  const n = node(), w = S.open.get(id); if (!n || !w) return;
  const d = S.data.get(id) || {};
  try {
    if (full || !d.discovered) { await discover(w, n); d.discovered = true; }
    d.state = await readState(w, n); d.error = '';
    S.data.set(id, d); if (onState) onState();                   // balance first: the history follows
    d.history = await readHistory(w, n);
  } catch (e) { d.error = e.message; d.history ||= []; }
  S.data.set(id, d);
}
async function refreshAll(full = false) {
  S.busy = true; render();
  const nodeP = refreshNode(), a = active();                     // node status and the active wallet are asked at the same time
  if (a) await refreshWallet(a.id, full, () => { S.busy = false; render(); });
  await nodeP;
  if (a && S.nodeOk) for (const w of walletsHere()) if (w.id !== a.id) refreshWallet(w.id, full).then(render);
  S.busy = false; render();
}

async function openAll() {
  S.open.clear(); S.data.clear();
  for (const r of S.vault.wallets) S.open.set(r.id, openWallet(r, r.kind === 'watch' ? null : await open(S.key, r.box)));
}
function lock() {
  for (const w of S.open.values()) { for (const k of w.keys.values()) k.privateKey?.fill?.(0); w.account?.wipePrivateData?.(); }
  S.key = null; S.draft = {}; S.open.clear(); S.data.clear(); S.modal = null; go('unlock'); }

// ---------------------------------------------------------------- ballots sent from this browser, and the live parts of the vote forms
const VOTES_KEY = 'zp-wallet.votes.v1';
function loadVotes() {
  try { const v = JSON.parse(localStorage.getItem(VOTES_KEY)); return Array.isArray(v) ? v.filter(x => x && /^[0-9a-f]{64}$/.test(x.hash)).slice(-40) : []; } catch { return []; }
}
const saveVotes = () => { try { localStorage.setItem(VOTES_KEY, JSON.stringify((S.myVotes || []).slice(-40))); } catch { /* private mode */ } };
function rememberVote(v) { (S.myVotes ||= loadVotes()).push({ ...v, net: net(), at: Date.now(), state: 'pending' }); saveVotes(); }
// ask the node where each ballot of this browser is: not found yet, in the mempool, or in a block
async function refreshVotes() {
  const n = node(); if (!n || S.screen !== 'vote') return;
  let changed = false;
  for (const v of (S.myVotes ||= loadVotes()).filter(x => x.net === net() && x.state !== 'block')) {
    try {
      const t = await n.request('/blockchain/transaction?hash=' + v.hash), bn = t && (t.blockNumber ?? t.block);
      const st = (t && Number.isSafeInteger(t.confirmations) && t.confirmations > 0) || Number.isSafeInteger(bn) ? 'block' : 'mempool';
      if (st !== v.state) { v.state = st; if (Number.isSafeInteger(bn)) v.block = bn; changed = true; }
    } catch { /* not known to the node (yet) */ }
  }
  if (changed) { saveVotes(); if (!S.modal && !document.activeElement?.closest?.('form[data-form]')) render(); }
}
function sentCard(c) {
  const list = (S.myVotes ||= loadVotes()).filter(v => v.net === net() && c && v.interval === c.interval).reverse();
  if (!list.length) return '';
  const badge = v => v.state === 'block' ? `<span class="ok nb">✓ In a block${v.block ? ' (' + Number(v.block).toLocaleString('en-US') + ')' : ''}</span>`
    : v.state === 'mempool' ? '<span class="warnc">Accepted, waiting for a block</span>' : '<span class="muted">Sent, waiting for the node</span>';
  return `<div class="card"><h2>Your ballots</h2><p class="muted small">Sent from this browser in interval ${c.community}. A ballot counts once it is in a block of its phase.</p>
    ${list.map(v => `<div class="kv"><span>${esc(v.kind)}: ${esc(v.label)}${v.to ? `<br><span class="mono small muted">${esc(shortAddr(v.to))}</span>` : ''}</span><span>${badge(v)}</span></div>`).join('')}</div>`;
}
// these parts change while typing: they are updated in place (a re-render would put the old field values back)
function syncAlloc(raw, from) {
  const inp = $app.querySelector('input[name=pct]'); if (!inp) return;
  const min = +inp.dataset.min, max = +inp.dataset.max, cur = +inp.dataset.cur, t = String(raw).trim(), n = Number(t);
  if (from !== 'field') inp.value = t;
  const okv = /^\d{1,3}$/.test(t) && n >= min && n <= max;
  const slider = $app.querySelector('input[name=pctr]'); if (slider && okv) slider.value = n;
  $app.querySelectorAll('[data-act=alloc-pick]').forEach(b => b.classList.toggle('on', b.dataset.v === t));
  const v = $app.querySelector('#alloc-v'), m = $app.querySelector('#alloc-m'), note = $app.querySelector('#alloc-note'), go = $app.querySelector('#alloc-go');
  if (v) v.textContent = okv ? `CGP ${n}%` : 'CGP ?';
  if (m) m.textContent = okv ? `miners ${100 - n}%` : '';
  if (note) {
    note.className = 'small ' + (okv || !t ? 'muted' : 'bad');
    const d = Math.abs(n - cur);
    note.textContent = !t ? '' : !okv ? `Only ${min}% to ${max}% counts` : n === cur ? 'Same as now: you vote to keep the split' : `${n > cur ? 'Raises' : 'Lowers'} the CGP share by ${d} point${d === 1 ? '' : 's'} (miners ${n > cur ? 'lose' : 'gain'} ${d})`;
  }
  if (go) go.disabled = !okv || !voters().length;
}
// about 4 minutes per block on mainnet: 365 blocks a day. The testnet pace varies, so only blocks are named there
function extendPresets() {
  return net() === 'main' ? [[10950, '30 days'], [32850, '90 days'], [65700, '180 days'], [131400, '1 year']] : [[1000, '1,000'], [10000, '10,000'], [100000, '100,000']];
}
function syncExtend() {
  const m = S.modal, inp = $app.querySelector('input[name=blocks]'); if (!m || m.type !== 'extend' || !inp) return;
  const t = inp.value.trim(), n = Number(t), okn = /^\d{1,8}$/.test(t) && n >= 1 && n <= MAX_EXTEND_BLOCKS;
  $app.querySelectorAll('[data-act=ext-pick]').forEach(b => b.classList.toggle('on', b.dataset.v === t));
  const cost = $app.querySelector('#ext-cost'), nw = $app.querySelector('#ext-new'), note = $app.querySelector('#ext-note'), go = $app.querySelector('#ext-go');
  const price = okn ? extendCost(m.code, n) : null, short = price !== null && m.balance !== null && price > m.balance;
  cost.textContent = price === null ? '–' : formatZP(price) + ' ZP'; nw.textContent = okn ? (m.expire + n - 1).toLocaleString('en-US') : '–';
  note.className = 'small ' + (!t || (okn && !short) ? 'muted' : 'bad');
  note.textContent = !t ? '' : !okn ? `Enter a whole number of blocks, from 1 to ${MAX_EXTEND_BLOCKS.toLocaleString('en-US')}` : short ? 'Not enough ZP in this wallet' : (net() === 'main' ? (n < 365 ? 'Less than a day' : `About ${(n / 365).toLocaleString('en-US', { maximumFractionDigits: 1 })} days`) : '');
  go.disabled = !okn || short;
}
function syncTo() {
  const inp = $app.querySelector('input[name=to]'), note = $app.querySelector('#to-note'); if (!inp || !note) return;
  const a = inp.value.replace(/\s+/g, ''); if (a !== inp.value) inp.value = a;
  if (!a) { note.textContent = ''; note.className = 'small'; return; }
  let msg, good = false;
  try {
    const d = decodeAddress(a), name = d.chain === 'main' ? 'mainnet' : 'testnet';
    if (d.chain !== net()) msg = `✗ This is a ${name} address, but this wallet is on ${net() === 'main' ? 'mainnet' : 'testnet'}`;
    else { good = true; const own = walletsHere().find(w => receiveAddress(S.open.get(w.id)) === a); msg = `✓ Valid ${name} ${d.contract ? 'contract ' : ''}address${own ? ` (your wallet “${own.name}”)` : ''}`; }
  } catch { msg = '✗ Not a valid address: check that every character was copied'; }
  note.textContent = msg; note.className = 'small ' + (good ? 'ok' : 'bad');
}
function syncAmt() {
  const inp = $app.querySelector('input[name=amount]'), note = $app.querySelector('#amt-note'); if (!inp || !note || !inp.closest('[data-form=vote-nom]')) return;
  const fund = inp.dataset.fund === '' ? null : Number(inp.dataset.fund), raw = inp.value.trim(); if (!raw) return;
  let amt = null; try { amt = parseZP(raw); } catch { /* invalid */ }
  const fundText = fund === null ? '' : `The CGP fund holds ${zpStr(fund)} ZP`;
  if (amt === null || amt <= 0n) { note.className = 'small bad'; note.textContent = 'Enter a positive amount, for example 1.5'; }
  else if (fund !== null && Number(amt) / 1e8 > fund) { note.className = 'small bad'; note.textContent = `${fundText}: ask for less`; }
  else { note.className = 'small muted'; note.textContent = fundText; }
}

// ---------------------------------------------------------------- events
$app.addEventListener('click', async e => {
  S.lastActivity = Date.now();
  const t = e.target.closest('button,[data-go]'); if (!t) return;
  if (t.dataset.go) {
    if (t.dataset.go === 'add') { S.draft = {}; S.tab = 'new'; }
    if (t.dataset.go === 'send') S.draft = {};
    return go(t.dataset.go);
  }
  if (t.dataset.tab) { S.tab = t.dataset.tab; S.error = ''; return render(); }
  if (t.dataset.wallet) { S.settings.active = t.dataset.wallet; saveSettings(); render(); if (!S.data.get(t.dataset.wallet)?.state) { await refreshWallet(t.dataset.wallet); render(); } return; }
  if (t.dataset.net) { S.settings.network = t.dataset.net; saveSettings(); S.tip = null; S.nodeOk = null; render(); return refreshAll(); }
  const act = t.dataset.act; if (!act) return;
  try {
    if (act === 'refresh') return refreshAll(true);
    if (act === 'vote-toggle' || act === 'vote-all' || act === 'vote-none') {
      const all = walletsHere().filter(w => w.kind !== 'watch').map(w => w.id);
      let sel = voters().map(w => w.id);
      if (act === 'vote-all') sel = all; else if (act === 'vote-none') sel = [];
      else sel = sel.includes(t.dataset.id) ? sel.filter(x => x !== t.dataset.id) : [...sel, t.dataset.id];
      S.settings.voteWallets[net()] = sel.length === all.length ? null : sel; saveSettings(); return render();
    }
    if (act === 'alloc-pick') return syncAlloc(t.dataset.v);
    if (act === 'use-addr') { const i = $app.querySelector('input[name=to]'); i.value = t.dataset.addr; return syncTo(); }
    if (act === 'paste-to') {
      const i = $app.querySelector('input[name=to]'), note = $app.querySelector('#to-note');
      try { i.value = (await navigator.clipboard.readText()).trim(); syncTo(); }
      catch { note.className = 'small bad'; note.textContent = 'This browser did not allow reading the clipboard: press and hold in the field, then choose Paste'; }
      return;
    }
    if (act === 'extend') {
      const k = S.contracts[+t.dataset.i], a = active(); if (!k || !a) return;
      const list = await node().activeContracts(), c = Array.isArray(list) ? list.find(x => x && (x.contractId === k.id || x.address === k.address)) : null;
      if (!c || typeof c.code !== 'string' || !c.code) throw new Error('The node did not return this contract’s code');
      await refreshWallet(a.id);
      const zp = S.data.get(a.id)?.state?.assets.find(x => x.asset === '00');
      S.modal = { type: 'extend', id: c.contractId, name: k.name, code: c.code, expire: Number(c.expire ?? c.expiry ?? k.expire), balance: S.data.get(a.id)?.state ? (zp?.spendable ?? 0n) : null, blocks: '' };
      S.error = ''; render(); return syncExtend();
    }
    if (act === 'ext-pick') { $app.querySelector('input[name=blocks]').value = t.dataset.v; return syncExtend(); }
    if (act === 'confirm-extend') {
      S.busy = true; render();
      const m = S.modal, hash = await publish(node(), m.prepared);
      S.busy = false; S.modal = { type: 'extended', hash, name: m.name, blocks: m.blocks }; render(); setTimeout(() => { refreshAll(); }, 5000); return;
    }
    if (act === 'close') { S.modal = null; S.error = ''; return render(); }
    if (act === 'lock') return lock();
    if (act === 'toggle-pw') { const inp = t.parentElement.querySelector('input'), show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; t.textContent = show ? 'Hide' : 'Show'; t.setAttribute('aria-pressed', String(show)); t.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); return; }
    if (act === 'copy') { await navigator.clipboard.writeText(t.dataset.text); t.innerHTML = I.copy + 'Copied'; return; }
    if (act === 'max') { const zp = S.data.get(active().id)?.state?.assets.find(x => x.asset === '00'); $app.querySelector('[name=amount]').value = formatZP(zp?.spendable || 0n).replace(/,/g, ''); return; }
    if (act === 'node-default') { S.settings.nodes[net()] = defaultNode(net()); saveSettings(); render(); return refreshAll(); }
    if (act === 'reveal') { const r = S.vault.wallets.find(w => w.id === t.dataset.id); S.modal = { type: 'reveal', id: r.id, name: r.name, kind: r.kind }; S.error = ''; return render(); }
    if (act === 'remove') { const r = S.vault.wallets.find(w => w.id === t.dataset.id); S.modal = { type: 'confirm', title: `Remove ${r.name}?`, text: 'It is deleted from this browser. Without its 24 words or key you cannot get it back.', ok: 'Remove', act: 'do-remove', id: r.id }; return render(); }
    if (act === 'do-remove') { S.vault.wallets = S.vault.wallets.filter(w => w.id !== t.dataset.id); storage.save(S.vault); S.open.delete(t.dataset.id); S.modal = null; return render(); }
    if (act === 'reset') { S.modal = { type: 'confirm', title: 'Remove all wallets from this browser?', text: 'Only do this if you have the 24 words or keys of every wallet. Then add them again with a new password.', ok: 'Remove all', act: 'do-reset' }; return render(); }
    if (act === 'do-reset') { storage.clear(); S.vault = null; S.modal = null; return go('welcome'); }
    if (act === 'load-cands') { S.cands = await node().candidates(); if (!Array.isArray(S.cands)) S.cands = []; return render(); }
    if (act === 'vote-cand') { const x = S.cands[+t.dataset.i]; return await reviewVote('payout vote', 'Payout', candidateBallot(x), `Pay ${x.spendlist.map(s => s.asset === '00' ? formatZP(BigInt(s.amount)) + ' ZP' : 'asset').join(' + ')}`, [['To', x.recipient, true]]); }
    if (act === 'confirm-vote') {
      S.busy = true; render();
      const m = S.modal, hash = await publish(node(), m.prepared);
      (S.pendingVotes ||= []).push({ spent: m.prepared.spent, at: Date.now() });
      rememberVote({ hash, kind: m.kind, label: m.label, to: (m.rows || []).find(r => r[0] === 'To')?.[1] || '', interval: m.prepared.phase.interval, phase: m.prepared.phase.phase });
      S.busy = false; S.modal = { type: 'voted', hash, kind: m.kind, label: m.label }; render(); setTimeout(refreshVotes, 5000); return;
    }
    if (act === 'confirm-send') {
      S.busy = true; render();
      const m = S.modal, hash = await publish(node(), m.prepared);
      S.busy = false; S.modal = { type: 'sent', amount: m.amount, hash }; S.draft = {};
      S.screen = 'home'; render(); setTimeout(() => refreshAll(), 1500); return;
    }
  } catch (err) { fail(err); }
});

$app.addEventListener('input', e => {
  const t = e.target; S.lastActivity = Date.now();
  if (t.name === 'pct') syncAlloc(t.value, 'field');
  else if (t.name === 'pctr') syncAlloc(t.value, 'slider');
  else if (t.name === 'to' && t.closest('[data-form=vote-nom]')) syncTo();
  else if (t.name === 'amount') syncAmt();
  else if (t.name === 'blocks') syncExtend();
});

$app.addEventListener('submit', async e => {
  e.preventDefault(); S.lastActivity = Date.now();
  const f = e.target, v = Object.fromEntries(new FormData(f));
  try {
    switch (f.dataset.form) {
      case 'create-vault': {
        if (v.p1 !== v.p2) throw new Error('The passwords differ');
        S.busy = true; render();
        const { vault, key } = await createVault(v.p1);
        S.vault = vault; S.key = key; storage.save(vault); S.busy = false; S.draft = {}; S.tab = 'new'; return go('add');
      }
      case 'unlock': {
        S.busy = true; render();
        S.key = await unlockVault(S.vault, v.p); await openAll(); S.busy = false;
        go('home'); return refreshAll();
      }
      case 'add-wallet': {
        const rec = { id: crypto.randomUUID(), name: (v.name || 'Wallet').trim().slice(0, 40), network: net(), createdAt: Date.now() };
        let secret = null;
        if (S.tab === 'new') { rec.kind = 'mnemonic'; secret = S.draft.words.join(' '); }
        else if (S.tab === 'phrase') { secret = v.words.trim().toLowerCase().split(/\s+/).join(' '); if (!checkMnemonic(secret)) throw new Error('These words are not a valid recovery phrase. Check spelling and order.'); rec.kind = 'mnemonic'; }
        else if (S.tab === 'key') { rec.kind = 'key'; secret = v.key.trim(); }
        else { const a = v.addr.trim(); if (!isValidAddress(a, net())) throw new Error(`Not a valid ${net() === 'main' ? 'mainnet' : 'testnet'} address`); rec.kind = 'watch'; rec.addresses = [a]; }
        const opened = openWallet(rec, secret);               // validates the key before saving
        if (secret) rec.box = await seal(S.key, secret);
        S.vault.wallets.push(rec); storage.save(S.vault); S.open.set(rec.id, opened);
        S.settings.active = rec.id; saveSettings(); S.draft = {};
        go('home'); return refreshAll(true);
      }
      case 'send': {
        const to = v.to.trim(); S.draft = { to, amount: v.amount };
        if (!isValidAddress(to, net())) { decodeAddress(to); throw new Error('Not a valid address for this network'); }
        const raw = v.amount.trim();
        const amount = parseZP(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw);   // only thousands separators; "1,5" is refused
        if (amount <= 0n) throw new Error('Enter an amount');
        const a = active(); await refreshWallet(a.id);
        const d = S.data.get(a.id);
        if (!d?.state || d.error) throw new Error('Could not read the balance from the node' + (d?.error ? ': ' + d.error : ''));
        const prepared = prepareSend(S.open.get(a.id), S.data.get(a.id).state, to, amount);
        S.modal = { type: 'confirm-send', to, amount, prepared }; S.error = ''; return render();
      }
      case 'vote-alloc': {
        S.draft.pct = v.pct; const pct = Number(v.pct.trim());
        const r = allocationRange(CGP_PARAMS[net()], alloc());
        if (!(pct >= r.min && pct <= r.max)) throw new Error(`With ${alloc()}% in force, only ${r.min}% to ${r.max}% counts`);
        return await reviewVote('allocation vote', 'Allocation', allocationBallot(pct), `${pct}% of block rewards to the CGP`, [['Now in force', `${alloc()}%`]]);
      }
      case 'vote-nom': {
        S.draft.nto = v.to; S.draft.namount = v.amount;
        const to = v.to.trim(); let ok = false; try { ok = decodeAddress(to).chain === net(); } catch { /* invalid */ }
        if (!ok) throw new Error('Not a valid address for this network');
        const amount = parseZP(v.amount.trim()); if (amount <= 0n) throw new Error('Enter an amount');
        const fund = S.stats?.cgp?.balance?.zp; if (Number.isFinite(fund) && Number(amount) / 1e8 > fund) throw new Error(`The CGP fund holds ${zpStr(fund)} ZP: ask for less`);
        return await reviewVote('nomination', 'Nomination', payoutBallot(to, [{ asset: ZP, amount }]), `Pay ${formatZP(amount)} ZP`, [['To', to, true]]);
      }
      case 'extend': {
        const m = S.modal, blocks = Number(v.blocks.trim()), a = active(); m.blocks = v.blocks;
        await refreshWallet(a.id);
        const d = S.data.get(a.id); if (!d?.state || d.error) throw new Error('Could not read the balance from the node');
        const prepared = prepareExtend(S.open.get(a.id), d.state, m.id, m.code, blocks);
        S.modal = { ...m, type: 'confirm-extend', blocks, prepared }; S.error = ''; return render();
      }
      case 'node': {
        const url = v.url.trim().replace(/\/+$/, '');
        let u = null; try { u = url && new URL(url); } catch { /* invalid */ }
        if (url && !(u && (u.protocol === 'https:' || (u.protocol === 'http:' && (['localhost', '127.0.0.1'].includes(u.hostname) || u.origin === location.origin))) && !u.username && !u.password))
          throw new Error('Use https://, or http://localhost for a node on this computer (or the address of the site that serves this wallet)');
        S.settings.nodes[net()] = url; saveSettings(); S.error = '';
        await refreshAll(); if (!S.nodeOk) throw new Error('Saved, but ' + (S.nodeError || 'the node does not answer'));
        return;
      }
      case 'reveal': {
        await unlockVault(S.vault, v.p);
        const r = S.vault.wallets.find(w => w.id === S.modal.id);
        S.modal.secret = await open(S.key, r.box); S.error = ''; return render();
      }
    }
  } catch (err) { fail(err); }
});

// auto-lock after inactivity; refresh balances every 2 minutes
setInterval(() => { if (S.key && Date.now() - S.lastActivity > LOCK_AFTER_MS) lock(); }, 30000);
setInterval(() => { if (S.key && S.screen === 'home' && !S.modal) refreshAll(); }, 120000);
setInterval(() => { if (S.key && S.screen === 'vote' && !S.modal) refreshVotes(); }, 20000);
['keydown', 'pointerdown'].forEach(ev => addEventListener(ev, () => { S.lastActivity = Date.now(); }, { passive: true }));

(async () => {
  try {
    const r = await fetch('config.json', { cache: 'no-cache' });
    const j = r.ok ? await r.json() : null;
    if (typeof j?.testNode === 'string' && /^https?:\/\//.test(j.testNode) && new URL(j.testNode).origin === location.origin || (typeof j?.testNode === 'string' && j.testNode.startsWith('https://'))) {
      S.siteDefaults = { test: j.testNode.replace(/\/+$/, '') };
      if (!S.settings.nodes.test) { S.settings.nodes.test = S.siteDefaults.test; saveSettings(); }
    }
  } catch { /* no config: nothing to default */ }
  go(S.vault ? 'unlock' : 'welcome');
  refreshNode().then(render);
})();
