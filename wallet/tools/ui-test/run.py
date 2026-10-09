"""Browser test of the wallet's CGP Vote screen against tools/ui-test/mock-node.mjs.
Run (from wallet/):  node build.mjs && (cd dist && python3 -m http.server 8081 &) && node tools/ui-test/mock-node.mjs --port 8082 &
                     python3 tools/ui-test/run.py [--net test|main] [--out DIR]
Needs python playwright with a Chromium (PLAYWRIGHT_BROWSERS_PATH). Screenshots go to --out. Prints OK/FAIL lines."""
import sys, json, re, urllib.request, os
from playwright.sync_api import sync_playwright
NET = sys.argv[sys.argv.index('--net') + 1] if '--net' in sys.argv else 'test'
OUT = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else '/tmp/claude-0/ui'
os.makedirs(OUT, exist_ok=True)
APP, NODE = 'http://localhost:8081/index.html', 'http://localhost:8082'
PHRASE = ' '.join(['abandon'] * 23 + ['art'])
bad = []
ADDR = json.load(urllib.request.urlopen(NODE + '/__addr'))
def ok(c, m):
    print(('OK   ' if c else 'FAIL ') + m)
    if not c: bad.append(m)
def mock(**kw): urllib.request.urlopen(NODE + '/__set?' + '&'.join(f'{k}={v}' for k, v in kw.items())).read()
def published(): return json.load(urllib.request.urlopen(NODE + '/__published'))

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 420, 'height': 900})
    ctx.add_init_script("localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'%s', nodes:{test:'%s', main:'%s'}}))" % (NET, NODE, NODE))
    pg = ctx.new_page()
    errors = []
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '404' not in m.text else None)   # the static test server has no config.json/stats.json
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    mock(tip=50 if NET == 'test' else 1053860, alloc=0 if NET == 'test' else 90, zp=5000, cands=1, reset=1)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]')
    pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('[data-go=vote]'); pg.wait_for_timeout(800)
    pg.screenshot(path=f'{OUT}/1-home.png')
    pg.click('button[data-go=vote]'); pg.wait_for_selector('h1:has-text("CGP vote")'); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{OUT}/2-vote-before.png', full_page=True)
    t = pg.inner_text('body')
    ok('Casting ballots' in t and 'Ballots open after the snapshot' in t, 'before the snapshot: ballots closed, explained')

    def reload_vote(tip, alloc, **kw):
        mock(tip=tip, alloc=alloc, **kw)
        pg.reload(); pg.wait_for_selector('form[data-form=unlock]'); pg.fill('input[name=p]', 'password123'); pg.click('form[data-form=unlock] button.primary')
        pg.wait_for_selector('[data-go=vote]'); pg.wait_for_timeout(600); pg.click('button[data-go=vote]'); pg.wait_for_selector('h1:has-text("CGP vote")'); pg.wait_for_timeout(500)

    # ranges
    VOTE_TIP = 95 if NET == 'test' else 1059600      # mainnet: interval 106, voting phase
    for last, want in [(0, '0% to 15%'), (50, '42% to 58%'), (90, '89% to 90%')]:   # 90% in force is the real mainnet case
        reload_vote(VOTE_TIP, last)
        t = pg.inner_text('body'); ok(want in t, f'allocation in force {last}% shows the range {want}')
    LAST = 0 if NET == 'test' else 90
    reload_vote(VOTE_TIP, LAST)
    pg.screenshot(path=f'{OUT}/3-vote-phase.png', full_page=True)
    # out of range, then in range
    pg.fill('input[name=pct]', '40'); pg.click('form[data-form=vote-alloc] button.primary'); pg.wait_for_timeout(600)
    t = pg.inner_text('body'); ok('Confirm allocation vote' not in t, 'a value out of range (40 with 0% in force) does not open the review'); print('     message:', re.findall(r'[^\n]*(?:range|between|valid)[^\n]*', t)[-1:] )
    pg.screenshot(path=f'{OUT}/4-alloc-out-of-range.png', full_page=True)
    pg.fill('input[name=pct]', '10' if NET == 'test' else '89'); pg.click('form[data-form=vote-alloc] button.primary'); pg.wait_for_selector('.modal'); pg.wait_for_timeout(400)
    pg.screenshot(path=f'{OUT}/5-alloc-review.png')
    ok('Confirm allocation vote' in pg.inner_text('.modal'), 'in-range value opens the review')
    pg.click('button[data-act=confirm-vote]'); pg.wait_for_selector('.modal h2.ok'); pg.screenshot(path=f'{OUT}/6-alloc-sent.png')
    pub = published(); ok(len(pub) == 1, f'one transaction published ({len(pub)})')
    pg.click('button[data-act=close]')
    # candidates and payout vote
    mock(tip=VOTE_TIP)
    pg.click('button[data-act=load-cands]'); pg.wait_for_timeout(600); pg.screenshot(path=f'{OUT}/7-candidates.png', full_page=True)
    items = pg.query_selector_all('button[data-act=vote-cand]'); ok(len(items) == 2, f'two candidates listed ({len(items)})')
    if items:
        items[0].click(); pg.wait_for_timeout(1500)
        t = pg.inner_text('body')
        ok('Confirm payout vote' in t or 'still waiting' in t, 'payout vote opens the review or says the last vote is still waiting for its block')
        pg.screenshot(path=f'{OUT}/8-payout-review.png')
    # nomination phase
    reload_vote(91 if NET == 'test' else 1059100, 0 if NET == 'test' else 90)   # mainnet: nomination phase
    pg.fill('input[name=to]', ADDR['other'])
    pg.fill('input[name=amount]', '1.5'); pg.screenshot(path=f'{OUT}/9-nomination.png', full_page=True)
    pg.click('form[data-form=vote-nom] button.primary'); pg.wait_for_timeout(1500)
    t = pg.inner_text('body'); print('     nomination result:', 'review opened' if 'Confirm nomination' in t else t[-300:].replace('\n', ' | '))
    pg.screenshot(path=f'{OUT}/10-nomination-review.png')
    ok(len(errors) == 0, 'no console errors: ' + '; '.join(errors[:5]))
    # a wallet with no ZP, and a node that does not answer: clear messages, no blank screen
    reload_vote(VOTE_TIP, LAST, zp=0)
    t = pg.inner_text('body'); pg.screenshot(path=f'{OUT}/11-zero-balance.png', full_page=True)
    pg.fill('input[name=pct]', '10' if NET == 'test' else '89'); pg.click('form[data-form=vote-alloc] button.primary'); pg.wait_for_timeout(1200)
    t = pg.inner_text('body'); ok('little ZP' in t or 'spendable output' in t, 'no ZP: the wallet says it needs a little ZP for the fee')
    pg.screenshot(path=f'{OUT}/12-zero-balance-error.png')
    mock(tip=VOTE_TIP, zp=5000)
    ctx2 = b.new_context(viewport={'width': 420, 'height': 900})
    ctx2.add_init_script("localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'%s', nodes:{test:'http://localhost:9', main:'http://localhost:9'}}))" % NET)
    pg2 = ctx2.new_page(); pg2.goto(APP); pg2.wait_for_selector('form[data-form=create-vault]')
    pg2.fill('input[name=p1]', 'password123'); pg2.fill('input[name=p2]', 'password123'); pg2.click('form[data-form=create-vault] button.primary')
    pg2.wait_for_selector('form[data-form=add-wallet]'); pg2.click('button[data-tab=phrase]'); pg2.click('button[data-tab=watch]')
    pg2.fill('input[name=addr]', ADDR['other'])
    pg2.click('form[data-form=add-wallet] button.primary'); pg2.wait_for_timeout(1500)
    pg2.click('button[data-go=vote]'); pg2.wait_for_timeout(5000); pg2.screenshot(path=f'{OUT}/13-node-down-watch-only.png', full_page=True)
    t = pg2.inner_text('body'); ok('Cannot reach the node' in t, 'node unreachable: clear message on the vote screen'); ok('Watch-only' in t or 'cannot sign' in t, 'watch-only wallet: told it cannot sign')
    b.close()
print('\n%d problem(s)' % len(bad) if bad else '\nall checks passed')
