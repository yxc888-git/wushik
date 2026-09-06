const { chromium } = require('C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node_modules/playwright-core');
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'https://yxc888-git.github.io/wushik/';
const log = (...a) => console.log('[online]', ...a);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('websocket', ws => {
    log('WS opened: ' + ws.url());
    ws.on('socketerror', e => log('WS ERROR: ' + e));
    ws.on('close', () => log('WS closed: ' + ws.url()));
  });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(1000);
  await page.click('#btnOnline');
  await page.waitForTimeout(800);
  await page.fill('#inpName', '测试房主');
  await page.click('#btnCreate');
  log('clicked create room');

  let roomNo = '';
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(1000);
    roomNo = (await page.locator('#roomNo').textContent().catch(() => '')) || '';
    if (roomNo && !roomNo.includes('------')) break;
  }
  log('roomNo = ' + roomNo);

  const roomBoxVisible = await page.locator('#roomBox').isVisible().catch(() => false);
  log('roomBox visible=' + roomBoxVisible);
  const seats = await page.locator('#seatList > *').count();
  log('seat entries=' + seats);
  const tip = await page.locator('#lobbyTip').textContent().catch(() => '');
  log('lobbyTip=' + (tip || '').trim().slice(0, 60));

  await page.waitForTimeout(3000);
  log('ERROR_COUNT=' + errors.length);
  errors.slice(0, 10).forEach(e => log('  ' + e));
  await browser.close();
})();
