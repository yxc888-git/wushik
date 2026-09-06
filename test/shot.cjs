/** 截图脚本：首页 / 牌桌 / 结算 / 规矩面板 */
const { chromium } = require('playwright-core');
const URL = process.argv[2] || 'http://localhost:8099';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 760 }, deviceScaleFactor: 1.5 });
  await page.goto(URL + '?fast=30', { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'test/shot-1-home.png' });

  await page.click('#btnSolo');
  await sleep(800);
  // 打几手，让桌面有内容
  for (let i = 0; i < 6; i++) {
    const turn = await page.evaluate(() => window.__wushik.game.turn);
    if (turn === 0) {
      await page.click('#btnHint'); await sleep(50);
      const n = await page.locator('#hand .card.sel').count();
      const ok = await page.locator('#btnPlay').isEnabled();
      if (n && ok) await page.click('#btnPlay');
      else if (await page.locator('#btnPass').isEnabled()) await page.click('#btnPass');
    }
    await sleep(400);
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test/shot-2-table.png' });

  // 规矩面板
  await page.click('#btnRules2'); await sleep(300);
  await page.screenshot({ path: 'test/shot-3-rules.png' });
  await page.click('#btnRulesClose');

  // 直接跑到结算
  for (let i = 0; i < 500; i++) {
    const st = await page.evaluate(() => {
      const u = window.__wushik; if (!u.game) return null;
      return { phase: u.game.phase, turn: u.game.turn };
    });
    if (!st || st.phase !== 'playing') break;
    if (st.turn !== 0) { await sleep(60); continue; }
    await page.click('#btnHint'); await sleep(40);
    const n = await page.locator('#hand .card.sel').count();
    const ok = await page.locator('#btnPlay').isEnabled();
    if (n && ok) await page.click('#btnPlay');
    else if (await page.locator('#btnPass').isEnabled()) await page.click('#btnPass');
    else await sleep(150);
    await sleep(60);
  }
  await sleep(800);
  await page.screenshot({ path: 'test/shot-4-result.png' });
  console.log('截图完成');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
