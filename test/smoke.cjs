/**
 * 浏览器冒烟测试：进单机 → 自动打完一整局 → 检查结算
 * 顺带抓 404 资源和 JS 报错。
 *
 * 跑法：
 *   NODE_PATH=<playwright 所在 node_modules> node test/smoke.cjs http://localhost:8099
 */
const { chromium } = require('playwright-core');

const URL = process.argv[2] || 'http://localhost:8099';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });

  const errors = [];
  const missing = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console.error] ' + m.text()); });
  page.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });

  const log = (...a) => console.log(...a);

  // fast=25：让 AI 别磨蹭，测试要跑完整局
  await page.goto(URL + (URL.includes('?') ? '&' : '?') + 'fast=25', { waitUntil: 'networkidle' });
  log('✓ 首页加载完成');

  await page.click('#btnSolo');
  await page.waitForTimeout(1000);

  // 第一局：掷骰子定首发（弹窗出现就点，等它关掉）
  const diceVisible = await page.locator('#modalDice.show').count();
  if (diceVisible) {
    await page.click('#btnRollDice');
    await page.waitForSelector('#modalDice.show', { state: 'detached', timeout: 10000 });
    log('✓ 掷骰子定首发完成');
  }

  const handCount = await page.locator('#hand .card').count();
  log(`✓ 进牌桌：手牌 ${handCount} 张`);

  // —— 自动打完一局：轮到我时就用「提示 + 出牌」，压不过就「不出」——
  let moves = 0, plays = 0, passes = 0;
  let finished = false;
  for (let i = 0; i < 400; i++) {
    const st = await page.evaluate(() => {
      const u = window.__wushik;
      if (!u || !u.game) return null;
      return { phase: u.game.phase, turn: u.game.turn, hand: u.game.hands[0].length };
    });
    if (!st) break;
    if (st.phase !== 'playing') { finished = true; break; }
    if (st.turn !== 0) { await sleep(120); continue; }

    // 轮到我
    const canPlay = await page.evaluate(() => {
      const u = window.__wushik;
      u.selected.clear();
      return true;
    });
    await page.click('#btnHint');
    await sleep(60);
    const selected = await page.locator('#hand .card.sel').count();
    const playEnabled = await page.locator('#btnPlay').isEnabled();
    if (selected > 0 && playEnabled) {
      await page.click('#btnPlay');
      plays++;
    } else {
      const passEnabled = await page.locator('#btnPass').isEnabled();
      if (passEnabled) { await page.click('#btnPass'); passes++; }
      else { await sleep(200); continue; }
    }
    moves++;
    await sleep(180);
  }

  log(`✓ 自动对局结束：我出了 ${plays} 手、不出 ${passes} 次（finished=${finished}）`);

  await page.waitForTimeout(900);
  const resultVisible = await page.locator('#modalResult').evaluate((el) => el.classList.contains('show'));
  log(`✓ 结算弹窗弹出：${resultVisible}`);

  let resultText = '';
  if (resultVisible) {
    resultText = await page.textContent('#resCatch');
    const table = await page.textContent('#resTable');
    log('  结算内容：' + resultText.replace(/\s+/g, ' ').trim());
    log('  名次表：' + table.replace(/\s+/g, ' ').trim().slice(0, 160));
    await page.screenshot({ path: 'test/shot-result.png' });
  }

  const finalState = await page.evaluate(() => {
    const u = window.__wushik;
    return {
      phase: u.game.phase,
      counts: u.game.hands.map((h) => h.length),
      pot: u.game.pot,
      result: u.game.result ? {
        mode: u.game.result.mode,
        penalty: u.game.result.penalty,
        finalScore: u.game.result.finalScore,
        order: u.game.result.order,
      } : null,
    };
  });
  log('✓ 终局状态：' + JSON.stringify(finalState));

  log('\n--- 检查 ---');
  log(missing.length === 0 ? '✓ 没有 404 资源' : '✗ 404：' + missing.join(', '));
  log(errors.length === 0 ? '✓ 没有 JS 报错' : '✗ 报错：\n  ' + errors.slice(0, 10).join('\n  '));

  await browser.close();
  process.exit(errors.length || missing.length ? 1 : 0);
})().catch((e) => { console.error('测试脚本自己挂了：', e); process.exit(2); });
