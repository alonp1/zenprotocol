// Shared header (menus) and footer for every page of the site. Reads /site-config.json, written by the setup scripts:
//   { "kind": "main" | "test", "name": "Zen Chain", "mainUrl": "https://example.org", "testUrl": "https://testnet.example.org", "github": "https://github.com/alonp1/zenprotocol" }
// Missing file: a main site named "Zen Chain" without cross links. Every string is set with textContent: nothing from the config is parsed as HTML.
(() => {
  const el = (tag, attrs = {}, kids = []) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'text') e.textContent = v; else e.setAttribute(k, v); }
    for (const c of [].concat(kids)) if (c) e.append(c);
    return e;
  };
  const safeUrl = u => (typeof u === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(u)) ? u.replace(/\/+$/, '') : '';
  const norm = p => p.replace(/index\.html$/, '').replace(/\/+$/, '') || '/';
  const here = norm(location.pathname);
  const same = href => { const h = norm(href); return h === here || (h !== '/' && href.endsWith('/') && here.startsWith(h)); };

  const MAIN = [
    ['Home', '/'],
    ['Network', [['Stats', '/stats.html', 'Block height, hashrate, supply'], ['Explorer', '/explorer.html', 'Blocks, transactions, addresses'], ['Assets', '/assets.html', 'Tokens issued on the chain'], ['CGP voting', '/cgp.html', 'Votes and payouts of the community fund'], ['Community votes', '/votes.html', 'Protocol upgrade votes, by commit'], ['Run a node', '/node.html', 'Install and snapshots'], ['Mine ZP', '/mine.html', 'GPU miner and what it earns']]],
    ['Wallet', '/wallet/'],
    ['Learn', [['About', '/about.html', 'What this network is'], ['How it works', '/how-it-works.html', 'Blocks, contracts, the CGP'], ['Community', '/community.html', 'How to take part']]],
    ['Developers', '/developers.html']
  ];
  const TEST = [
    ['Home', '/'],
    ['Trade', [['Markets', '/markets.html', 'Oracle prices and order books'], ['Dex', '/dex.html', 'Swap assets on the chain'], ['Oracle', '/oracle.html', 'Prices committed on the chain'], ['Bridge', '/bridge.html', 'USDC in and out (prototype)']]],
    ['Explore', [['Explorer', '/explorer.html', 'Blocks, transactions, addresses'], ['Assets', '/assets.html', 'Tokens on the testnet'], ['CGP voting', '/cgp.html', 'Votes and payouts']]],
    ['Wallet', '/wallet/'],
    ['Learn', [['Testnet guide', '/guide.html', 'First steps, test coins'], ['Instruments', '/instruments.html', 'Oracle, Dex and tokens together']]],
    ['Developers', '/developers.html']
  ];

  const start = cfg => {
    const kind = cfg.kind === 'test' ? 'test' : 'main';
    const name = typeof cfg.name === 'string' && cfg.name.length < 40 ? cfg.name : 'Zen Chain';
    const mainUrl = safeUrl(cfg.mainUrl), testUrl = safeUrl(cfg.testUrl), github = safeUrl(cfg.github) || 'https://github.com/alonp1/zenprotocol';
    document.querySelectorAll('main > nav').forEach(n => n.remove());       // the pages' old link rows
    const menu = kind === 'test' ? TEST : MAIN;

    const nav = el('nav', { class: 'zs-nav', 'aria-label': 'Main' });
    const closeAll = () => document.querySelectorAll('.zs-grp.open').forEach(g => { g.classList.remove('open'); g.firstChild.setAttribute('aria-expanded', 'false'); });
    for (const [label, target] of menu) {
      if (typeof target === 'string') { const a = el('a', { href: target, text: label }); if (same(target)) a.setAttribute('aria-current', 'page'); nav.append(a); continue; }
      const btn = el('button', { type: 'button', 'aria-expanded': 'false', text: label });
      const items = el('div', { class: 'zs-menu' }, target.map(([l, h, sub]) => {
        const a = el('a', { href: h }, [document.createTextNode(l), sub ? el('small', { text: sub }) : null]);
        if (same(h)) a.setAttribute('aria-current', 'page');
        return a;
      }));
      const grp = el('div', { class: 'zs-grp' + (target.some(t => same(t[1])) ? ' here' : '') }, [btn, items]);
      btn.addEventListener('click', e => { e.stopPropagation(); const was = grp.classList.contains('open'); closeAll(); if (!was) { grp.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); } });
      nav.append(grp);
    }
    const other = kind === 'test' ? mainUrl : testUrl;
    if (other) nav.append(el('a', { href: other, class: 'zs-other', text: kind === 'test' ? 'Mainnet →' : 'Testnet →' }));

    const burger = el('button', { type: 'button', class: 'zs-burger', 'aria-expanded': 'false', 'aria-label': 'Menu', text: 'Menu' });
    const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    mark.setAttribute('width', '26'); mark.setAttribute('height', '26'); mark.setAttribute('viewBox', '0 0 26 26'); mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = '<rect x="2" y="8" width="13" height="10" rx="5" fill="none" stroke="currentColor" stroke-width="2.4"/><rect x="11" y="8" width="13" height="10" rx="5" fill="none" stroke="currentColor" stroke-width="2.4"/>';
    const head = el('header', { class: 'zs-head' }, el('div', { class: 'zs-bar' }, [
      el('a', { href: '/', class: 'zs-brand', 'aria-label': name + ' home' }, [mark, document.createTextNode(name)]),
      el('span', { class: 'zs-net' + (kind === 'test' ? ' test' : ''), text: kind === 'test' ? 'Testnet' : 'Mainnet' }),
      burger, nav]));
    burger.addEventListener('click', () => { const o = head.classList.toggle('open'); burger.setAttribute('aria-expanded', String(o)); });
    document.addEventListener('click', closeAll);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
    nav.addEventListener('click', e => e.stopPropagation());   // inside the phone drawer a click must not close the group it opens
    document.querySelectorAll('table').forEach(t => {       // a wide table scrolls inside its own box, never the page
      const p = t.parentElement; if (p && (p.classList.contains('zs-tw') || p.classList.contains('tw'))) return;
      const w = el('div', { class: 'zs-tw' }); t.replaceWith(w); w.append(t);
    });
    document.body.prepend(head);
    if (kind === 'test') head.after(el('div', { class: 'zs-test-note', text: location.protocol === 'https:' ? 'Testnet: coins have no value.' : 'Testnet: coins have no value. Do not enter real keys or passwords on a plain-HTTP address.' }));

    const col = (title, links) => el('div', {}, [el('h3', { text: title }), ...links.map(([l, h]) => el('a', { href: h, text: l }))]);
    const foot = el('footer', { class: 'zs-foot' }, el('div', { class: 'zs-foot-in' }, [
      el('div', {}, [el('p', { text: name }), el('p', { text: 'A community-run network built on the Zen Protocol code. Open source, no company behind it.' })]),
      col('Network', [['Explorer', '/explorer.html'], ['Assets', '/assets.html'], ['CGP voting', '/cgp.html'], ...(kind === 'main' ? [['Community votes', '/votes.html']] : []), ['Wallet', '/wallet/']]),
      col(kind === 'test' ? 'Trade (testnet)' : 'Learn', kind === 'test' ? [['Markets', '/markets.html'], ['Dex', '/dex.html'], ['Oracle', '/oracle.html'], ['Bridge', '/bridge.html'], ['Guide', '/guide.html']] : [['About', '/about.html'], ['How it works', '/how-it-works.html'], ['Run a node', '/node.html'], ['Community', '/community.html']]),
      col('Project', [['Developers', '/developers.html'], ['Source code', github], ...(other ? [[kind === 'test' ? 'Mainnet' : 'Testnet', other]] : [])]),
      el('div', { class: 'zs-legal', text: 'Community-run. Not affiliated with or endorsed by Zen Protocol Ltd. Nothing here is financial advice. ' + (kind === 'test' ? 'Testnet coins have no value.' : '') })]));
    document.body.append(foot);
    document.title = document.title.replace(/^(ZP|Zen Chain)\b/, name);
  };

  fetch('/site-config.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({})).then(c => start(c && typeof c === 'object' ? c : {}));
})();
