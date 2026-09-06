const { chromium } = require('playwright-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:8099';
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const errors = [];
  const p = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  p.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('[console.error] ' + m.text()); });
  await p.goto(BASE + '/?fast=25', { waitUntil: 'networkidle' });
  await p.click('#btnOnline');
  await p.waitForTimeout(400);
  const hasInvite = await p.locator('#btnCopyInvite').count();
  const hasStart = await p.locator('#btnStartOnline').count();
  await p.screenshot({ path: 'test/shot-lobby.png' });

  const p2 = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  p2.on('pageerror', (e) => errors.push('[pageerror2] ' + e.message));
  await p2.goto(BASE + '/?room=123456', { waitUntil: 'networkidle' });
  await p2.click('#btnOnline');
  await p2.waitForTimeout(400);
  const prefilled = await p2.inputValue('#inpRoom');
  const joinShown = await p2.locator('#joinBlock').evaluate((el) => el.style.display !== 'none');

  console.log('邀请按钮存在:', hasInvite === 1);
  console.log('开始按钮存在:', hasStart === 1);
  console.log('深链房号预填:', JSON.stringify(prefilled), '→', prefilled === '123456' ? 'OK' : 'FAIL');
  console.log('深链加入框已展开:', joinShown);
  console.log('JS 报错数:', errors.length, errors.slice(0, 5).join(' | '));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
