"""Browser test of the wallet's Contracts screen: extending a contract (cost, blocks, confirm, broadcast message).
Same setup as run.py:  node build.mjs && (cd dist && python3 -m http.server 8081 &) && node tools/ui-test/mock-node.mjs --port 8082 [--net main] &
                       python3 tools/ui-test/run-extend.py [--net test|main] [--out DIR]"""
import sys, json, urllib.request, os
from playwright.sync_api import sync_playwright
NET = sys.argv[sys.argv.index('--net') + 1] if '--net' in sys.argv else 'test'
OUT = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else '/tmp/claude-0/ui'
os.makedirs(OUT, exist_ok=True)
APP, NODE = 'http://localhost:8081/index.html', 'http://localhost:8082'
PHRASE = ' '.join(['abandon'] * 23 + ['art'])
bad = []
def ok(c, m):
    print(('OK   ' if c else 'FAIL ') + m)
    if not c: bad.append(m)
def mock(**kw): urllib.request.urlopen(NODE + '/__set?' + '&'.join(f'{k}={v}' for k, v in kw.items())).read()
def published(): return json.load(urllib.request.urlopen(NODE + '/__published'))
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 420, 'height': 900})
    ctx.add_init_script("localStorage.setItem('zp-wallet.settings.v1', JSON.stringify({network:'%s', nodes:{test:'%s', main:'%s'}}))" % (NET, NODE, NODE))
    pg = ctx.new_page(); errors = []
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    mock(tip=50 if NET == 'test' else 1053860, alloc=0, zp=5000, cands=1, reset=1)
    pg.goto(APP); pg.wait_for_selector('form[data-form=create-vault]')
    pg.fill('input[name=p1]', 'password123'); pg.fill('input[name=p2]', 'password123'); pg.click('form[data-form=create-vault] button.primary')
    pg.wait_for_selector('form[data-form=add-wallet]'); pg.click('button[data-tab=phrase]'); pg.fill('textarea[name=words]', PHRASE); pg.click('form[data-form=add-wallet] button.primary')
    pg.wait_for_selector('[data-go=vote]'); pg.wait_for_timeout(800)
    pg.click('nav >> text=Contracts')
    pg.wait_for_selector('h1:has-text("Smart contracts")'); pg.wait_for_timeout(600)
    pg.screenshot(path=f'{OUT}/e1-contracts.png', full_page=True)
    ok(pg.query_selector('button[data-act=extend]') is not None, 'each contract has an Extend button')
    pg.click('button[data-act=extend]'); pg.wait_for_selector('form[data-form=extend]'); pg.wait_for_timeout(300)
    ok(pg.is_disabled('#ext-go'), 'Review is disabled until a number of blocks is chosen')
    ok('4,000 kalapas per block' in pg.inner_text('.sheet'), 'the price per block is shown (code length)')
    pg.fill('input[name=blocks]', '10000'); t = pg.inner_text('.sheet')
    ok('0.4 ZP' in pg.inner_text('#ext-cost'), 'cost of 10,000 blocks = 0.4 ZP: ' + pg.inner_text('#ext-cost'))
    ok(not pg.is_disabled('#ext-go'), 'a valid number enables Review')
    pg.screenshot(path=f'{OUT}/e2-extend-form.png')
    pg.fill('input[name=blocks]', '0'); ok(pg.is_disabled('#ext-go'), '0 blocks refused')
    pg.fill('input[name=blocks]', '99999999'); ok(pg.is_disabled('#ext-go'), 'a cost above the balance is refused: ' + pg.inner_text('#ext-note'))
    chip = pg.query_selector_all('button[data-act=ext-pick]')[0]; chip.click()
    ok(pg.input_value('input[name=blocks]') == chip.get_attribute('data-v'), 'a preset chip fills the field')
    pg.click('#ext-go'); pg.wait_for_selector('h2:has-text("Confirm extension")')
    pg.screenshot(path=f'{OUT}/e3-confirm.png')
    pg.click('button[data-act=confirm-extend]'); pg.wait_for_selector('h2:has-text("Broadcast successfully")')
    pg.screenshot(path=f'{OUT}/e4-done.png')
    ok(len(published()) == 1, 'one transaction reached the node')
    ok(not errors, 'no page errors: ' + str(errors))
    b.close()
print('FAILED: ' + '; '.join(bad) if bad else 'ALL OK'); sys.exit(1 if bad else 0)
