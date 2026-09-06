const { chromium } = require('C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node_modules/playwright-core');
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'https://yxc888-git.github.io/wushik/';
const log = (...a) => console.log('[smoke]', ...a);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', r => errors.push('REQFAIL: ' + r.url() + ' ' + (r.failure() && r.failure().errorText)));

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(1500);

  const homeActive = await page.locator('#home.active').count();
  log('home active=' + (homeActive > 0));
  const hasSolo = await page.locator('#btnSolo').count();
  log('btnSolo present=' + (hasSolo > 0));

  await page.click('#btnSolo');
  await page.waitForTimeout(2000);

  // dice modal?
  const diceVisible = await page.locator('#modalDice:not(.hidden)').count();
  log('dice modal visible=' + (diceVisible > 0));
  if (diceVisible) {
    await page.click('#btnRollDice');
    await page.waitForTimeout(2500);
  }

  const handCount = await page.locator('#hand .card').count();
  log('hand cards rendered=' + handCount);
  const tableActive = await page.locator('#table.active').count();
  log('table active=' + (tableActive > 0));
  const cnt = await page.locator('#cnt0').textContent().catch(() => '?');
  log('my card count label=' + cnt);

  // check a few module assets reachable
  for (const f of ['src/core/engine.js', 'src/net/mqtt.js', 'manifest.json', 'sw.js']) {
    const code = await page.evaluate(async (u) => {
      try { const r = await fetch(u, { method: 'HEAD' }); return r.status; } catch (e) { return 'ERR:' + e.message; }
    }, f);
    log('asset ' + f + ' => ' + code);
  }

  log('ERROR_COUNT=' + errors.length);
  errors.slice(0, 15).forEach(e => log('  ' + e));
  await browser.close();
})();
