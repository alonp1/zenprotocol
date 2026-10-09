import re, json

def run(browser, g):
    globals().update(g)
    logs = []
    ADDR_OTHER = None

    def fresh(width=1200, chain='test', **kw):
        page = new_page(browser, width, chain, logs)
        make_wallet(page)
        return page

    def vote_screen(page, tip, chain='test', **kw):
        ctl(chain, tip=tip, **kw)
        reload_vote(page)

    # ---- (1) open the screen, phases, labels ---------------------------------------------------
    ctl('test', tip=50, allocation=90, down=False, funded=True, candidates=[], reset=True)
    page = fresh()
    open_vote(page); shot(page, '01-before-snapshot')
    t = text(page)
    check('CGP vote' in t, 'screen title says CGP vote')
    check('Before snapshot' in t and 'Balance snapshot in 40 blocks' in t, 'testnet tip 50: before snapshot, 40 blocks left (got: %s)' % re.findall(r'Balance snapshot in [^\n]*', t))
    check('Snapshot block\n90' in t, 'testnet snapshot block 90 shown (got %s)' % re.findall(r'Snapshot block\n[^\n]*', t))
    check('Ballots open after the snapshot block (90)' in t, 'ballots card before snapshot names block 90')

    # phase table: tip -> (phase text, forms enabled)
    for tip, phase in [(89, 'Before snapshot'), (90, 'Nomination'), (94, 'Nomination'), (95, 'Voting'), (99, 'Voting'), (100, 'Before snapshot')]:
        vote_screen(page, tip)
        t = text(page)
        check(phase in t.split('\n')[3:12].__str__() or phase in t, 'tip %d shows %s' % (tip, phase))
        if tip in (90, 95): shot(page, '02-tip%d' % tip)

    # ---- (2) allocation range text ----------------------------------------------------------------
    for alloc, rng in [(0, '0% to 15%'), (50, '42% to 58%'), (90, '89% to 90%')]:
        vote_screen(page, 95, allocation=alloc)
        t = text(page)
        check('valid votes are %s' % rng in t, 'allocation %d in force -> %s' % (alloc, rng))
    vote_screen(page, 95, allocation=90)
    page.fill('input[name=pct]', '50'); page.click('form[data-form=vote-alloc] button.primary'); page.wait_for_timeout(300)
    check('only 89% to 90% counts' in text(page), 'out-of-range 50 rejected with message'); shot(page, '03-alloc-rejected')
    for bad in ['abc', '89.5', '-1', '']:
        page.fill('input[name=pct]', bad)
        page.click('form[data-form=vote-alloc] button.primary'); page.wait_for_timeout(200)
        t = text(page)
        check('Vote sent' not in t and 'Confirm' not in t, 'garbage allocation %r does not open review' % bad)
    page.fill('input[name=pct]', '89'); page.click('form[data-form=vote-alloc] button.primary')
    page.wait_for_selector('text=Confirm allocation vote'); shot(page, '04-alloc-review')
    t = text(page)
    check('89% of block rewards to the CGP' in t and 'Interval 1, Vote phase' in t, 'review modal content')
    page.click('button[data-act=confirm-vote]'); page.wait_for_selector('text=Vote sent'); shot(page, '05-alloc-sent')
    d = decode_published('test')
    check(d and d['wit'] == ['PK:FollowingWitnesses', 'Contract'] and d['cmd'] == 'Allocation', 'published tx has PK(FollowingWitnesses)+Contract witnesses: %s' % d)
    # expected body from cgp.js
    exp = subprocess.run(['node', '--input-type=module', '-e', """
import {voteBody,allocationBallot} from './src/cgp.js';import {CGP_PARAMS} from './src/cgp.js';
import {openWallet} from './src/wallet.js';import {deriveKey} from './src/keys.js';
const w=openWallet({id:'a',name:'a',network:'test',kind:'mnemonic'},process.argv[1]);const k=deriveKey(w.account,0,0);
console.log(voteBody(CGP_PARAMS.test,96,'Allocation',allocationBallot(89),[k]).hex)""", PHRASE], cwd=WALLET, capture_output=True, text=True).stdout.strip()
    check(d and d['body'] == exp, 'voting message body equals cgp.js voteBody (block 96, 89%%)')
    page.click('button[data-act=close]')
    # second vote: the funding output was spent by the first one (not in a block yet)
    ctl('test', reset=True)

    # ---- a second vote while the first is not in a block: no double spend --------------------------------------
    ctl('test', tip=95, reset=True)
    page = fresh()                       # the app remembers its pending votes: start a clean session
    vote_screen(page, 95)
    page.fill('input[name=pct]', '90'); page.click('form[data-form=vote-alloc] button.primary'); page.wait_for_selector('text=Confirm allocation vote')
    page.click('button[data-act=confirm-vote]'); page.wait_for_selector('text=Vote sent'); page.click('button[data-act=close]')
    page.fill('input[name=pct]', '90'); page.click('form[data-form=vote-alloc] button.primary'); page.wait_for_timeout(1500)
    t = text(page); shot(page, '05b-second-vote')
    check('still waiting for its block' in t, 'second vote before a block: clear message (tail: %s)' % t[-250:].replace('\n', ' | '))
    check(len(get('/__published?chain=test')) == 1, 'only one vote reached the node')
    ctl('test', confirm=True); vote_screen(page, 96)
    page.fill('input[name=pct]', '90'); page.click('form[data-form=vote-alloc] button.primary'); page.wait_for_selector('text=Confirm allocation vote')
    page.click('button[data-act=confirm-vote]'); page.wait_for_selector('text=Vote sent'); page.click('button[data-act=close]')
    check(len(get('/__published?chain=test')) == 2, 'after the block the next vote goes through (spends the change)')
    ctl('test', reset=True)

    # ---- last blocks of a phase / boundaries ---------------------------------------------------------
    for tip, kind, expect in [(97, 'alloc', 'Confirm'), (98, 'alloc', 'closes in a few blocks'), (99, 'alloc', 'closes in a few blocks'),
                              (100, 'alloc', 'only in the voting phase'), (94, 'alloc', 'only in the voting phase')]:
        vote_screen(page, tip)
        if tip in (100,):
            t = text(page); check('Before snapshot' in t, 'tip 100: new interval, before snapshot')
            continue
        page.fill('input[name=pct]', '90')
        btn = page.query_selector('form[data-form=vote-alloc] button.primary')
        if not btn:
            check(expect != 'Confirm', 'tip %d: no allocation button shown (text: opens with voting phase)' % tip); continue
        btn.click(); page.wait_for_timeout(600)
        t = text(page)
        check(expect in t, 'tip %d allocation -> %r (tail: %s)' % (tip, expect, t[-200:].replace('\n', ' | ')))
        if page.query_selector('button[data-act=close]'): page.click('button[data-act=close]')
    shot(page, '06-phase-edge')

    # ---- (3) nomination ---------------------------------------------------------------------------------
    other = get('/__info')['test'].replace('qqfjjy6ewd4thlj7erqsp2575hnm9mqnlrpaze9z6aafa7camxzdqshjlp3', 'qqfjjy6ewd4thlj7erqsp2575hnm9mqnlrpaze9z6aafa7camxzdqshjlp3')
    vote_screen(page, 91)
    shot(page, '07-nomination-phase')
    page.fill('form[data-form=vote-nom] input[name=to]', 'notanaddress'); page.fill('form[data-form=vote-nom] input[name=amount]', '10')
    page.click('form[data-form=vote-nom] button.primary'); page.wait_for_timeout(300)
    check('Not a valid address for this network' in text(page), 'nomination: bad address message')
    page.fill('form[data-form=vote-nom] input[name=to]', get('/__info')['test'])
    for amt, ok in [('0', False), ('-5', False), ('abc', False), ('1,5', False), ('10', True)]:
        page.fill('form[data-form=vote-nom] input[name=amount]', amt)
        page.click('form[data-form=vote-nom] button.primary'); page.wait_for_timeout(400)
        t = text(page)
        check(('Confirm nomination' in t) == ok, 'nomination amount %r -> %s' % (amt, 'review' if ok else 'refused (%s)' % t.split('\n')[-12:-8]))
        if ok: shot(page, '08-nomination-review'); page.click('button[data-act=close]')
    # mainnet address in testnet wallet
    page.fill('form[data-form=vote-nom] input[name=to]', get('/__info')['main']); page.fill('form[data-form=vote-nom] input[name=amount]', '10')
    page.click('form[data-form=vote-nom] button.primary'); page.wait_for_timeout(300)
    check('Not a valid address for this network' in text(page), 'nomination: mainnet address refused on testnet')
    vote_screen(page, 95)
    t = text(page); check('Opens in the nomination phase' in t, 'voting phase: nomination form says it is closed')
    page.fill('form[data-form=vote-nom] input[name=to]', get('/__info')['test']); page.fill('form[data-form=vote-nom] input[name=amount]', '10')
    check(page.query_selector('form[data-form=vote-nom] button.primary') is None, 'no nomination submit button outside nomination phase')

    # ---- (4)+(5) candidates --------------------------------------------------------------------------------
    cgp_contract = subprocess.run(['node', '--input-type=module', '-e', """
import {encodeAddress} from './src/keys.js';import {unhex} from './src/serialize.js';
console.log(encodeAddress(unhex('00000000cdaa2a511cd2e1d07555b00314d1be40a649d3b6f419eb1e4e7a8e63240a36d1'),'test',true))"""], cwd=WALLET, capture_output=True, text=True).stdout.strip()
    cands = [{'recipient': cgp_contract, 'spendlist': [{'asset': '00', 'amount': 1}]},
             {'recipient': get('/__info')['test'], 'spendlist': [{'asset': '00', 'amount': 250000000000}]}]
    ctl('test', candidates=cands, reset=True)
    vote_screen(page, 95)
    page.click('button[data-act=load-cands]'); page.wait_for_selector('button[data-act=vote-cand]'); shot(page, '09-candidates')
    items = page.query_selector_all('button[data-act=vote-cand]')
    check(len(items) == 2, 'two candidates listed')
    print('   candidate rows:', [i.inner_text().replace('\n', ' | ') for i in items])
    items[0].click(); page.wait_for_selector('text=Confirm payout vote'); shot(page, '10-cand-review')
    page.click('button[data-act=confirm-vote]'); page.wait_for_selector('text=Vote sent')
    d = decode_published('test')
    want = '0202' + '00cdaa2a511cd2e1d07555b00314d1be40a649d3b6f419eb1e4e7a8e63240a36d1' + '01' + '00' + '0001'
    ok = d and d['cmd'] == 'Payout' and want.replace('0202', '') != '' and ('020200cdaa2a511cd2e1d07555b00314d1be40a649d3b6f419eb1e4e7a8e63240a36d101000001'.encode().hex()) in d['body']
    check(bool(ok), 'contract-recipient payout ballot encoded 02||02||VarInt(version)||hash32 in body: %s' % (d or {}).get('cmd'))
    page.click('button[data-act=close]')
    ctl('test', reset=True)
    page.click('nav button[data-go=home]'); page.click('button[data-act=refresh]'); page.wait_for_timeout(600); open_vote(page)
    page.click('button[data-act=load-cands]'); page.wait_for_selector('button[data-act=vote-cand]')
    page.query_selector_all('button[data-act=vote-cand]')[1].click(); page.wait_for_selector('text=Confirm payout vote')
    page.click('button[data-act=confirm-vote]'); page.wait_for_selector('text=Vote sent'); page.click('button[data-act=close]')
    ctl('test', reset=True, candidates=[])

    # candidates in nomination phase: disabled; empty list
    vote_screen(page, 91, candidates=cands)
    page.click('button[data-act=load-cands]'); page.wait_for_selector('button[data-act=vote-cand]')
    check(page.query_selector('button[data-act=vote-cand]').is_disabled(), 'candidates disabled in nomination phase')
    ctl('test', candidates=[])
    vote_screen(page, 95)
    page.click('button[data-act=load-cands]'); page.wait_for_timeout(400)
    check('No candidates in this interval' in text(page), 'empty candidate list message')

    # ---- (6) phone width ------------------------------------------------------------------------------------
    ph = fresh(400)
    ctl('test', tip=95, allocation=90, reset=True, candidates=cands)
    open_vote(ph)
    ph.click('button[data-act=load-cands]'); ph.wait_for_selector('button[data-act=vote-cand]')
    shot(ph, '11-phone-vote')
    sw = ph.evaluate('document.documentElement.scrollWidth'); check(sw <= 400, 'no horizontal overflow at 400px (scrollWidth %d)' % sw)
    ph.fill('input[name=pct]', '90'); ph.click('form[data-form=vote-alloc] button.primary'); ph.wait_for_selector('text=Confirm allocation vote')
    shot(ph, '12-phone-review')
    ph.click('button[data-act=confirm-vote]'); ph.wait_for_selector('text=Vote sent'); shot(ph, '13-phone-sent')
    sw = ph.evaluate('document.documentElement.scrollWidth'); check(sw <= 400, 'no horizontal overflow in modal at 400px')
    ctl('test', reset=True, candidates=[])

    # ---- (7) zero ZP, watch-only, node down ---------------------------------------------------------------------
    ctl('test', tip=95, funded=False)
    z = fresh(); open_vote(z)
    z.fill('input[name=pct]', '90'); z.click('form[data-form=vote-alloc] button.primary'); z.wait_for_timeout(800)
    shot(z, '14-zero-zp'); t = text(z)
    check('little ZP' in t or 'ZP' in t and 'fee' in t, 'zero ZP: clear message (%s)' % [l for l in t.split('\n') if 'fee' in l.lower()][:2])
    ctl('test', funded=True)
    wo = new_page(browser, 1200, 'test', logs); make_wallet(wo, 'watch', get('/__info')['test'], 'Watch')
    open_vote(wo); shot(wo, '15-watch-only'); t = text(wo)
    check('Watch-only wallets cannot sign' in t, 'watch-only: explanation shown')
    print('   watch-only forms present:', bool(wo.query_selector('form[data-form=vote-alloc]')), 'buttons disabled:', [b.is_disabled() for b in wo.query_selector_all('form button.primary')])
    wo.fill('input[name=pct]', '90')
    b = wo.query_selector('form[data-form=vote-alloc] button.primary')
    if b and not b.is_disabled(): b.click(); wo.wait_for_timeout(600)
    shot(wo, '15b-watch-only-after'); print('   watch-only after submit tail:', text(wo)[-300:].replace('\n', ' | '))
    ctl('test', down=True)
    dlogs = []
    dn = new_page(browser, 1200, 'test', dlogs); make_wallet(dn)
    
    dn.wait_for_timeout(500); open_vote(dn); dn.wait_for_timeout(5000); shot(dn, '16-node-down'); t = text(dn)
    check('offline' in t.lower() or 'unreachable' in t.lower(), 'node down: offline message shown')
    print('   node-down text:', t[:400].replace('\n', ' | '))
    ctl('test', down=False)
    check('Cannot reach the node' in t, 'node down: vote screen explains it (not a bare Loading)')

    # ---- (8) mainnet --------------------------------------------------------------------------------------------------
    ctl('main', tip=2459600, allocation=90, funded=True, reset=True)
    m = new_page(browser, 1200, 'main', logs); make_wallet(m); open_vote(m); shot(m, '17-main-vote'); t = text(m)
    check('valid votes are 89% to 90%' in t and 'INTERVAL' in t, 'mainnet allocation range 89-90 (%s)' % t[:700].replace('\n',' | '))
    check('Voting' in t and 'Snapshot block\n2,459,000' in t, 'mainnet interval 246: snapshot 2,459,000, voting (%s)' % re.findall(r'Snapshot block\n[^\n]*', t))
    for tip, ph_ in [(2459000, 'Nomination'), (2459500, 'Voting'), (2458999, 'Before snapshot'), (2460000, 'Before snapshot')]:
        ctl('main', tip=tip); reload_vote(m); check(ph_ in text(m), 'mainnet tip %d -> %s' % (tip, ph_))
    ctl('main', tip=2459600); reload_vote(m)
    m.fill('input[name=pct]', '89'); m.click('form[data-form=vote-alloc] button.primary'); m.wait_for_selector('text=Confirm allocation vote'); shot(m, '18-main-review')
    m.click('button[data-act=confirm-vote]'); m.wait_for_selector('text=Vote sent')
    check(decode_published('main') is not None, 'mainnet vote published')

    check(not logs, 'no console errors / unhandled rejections: %s' % sorted(set(logs)))
