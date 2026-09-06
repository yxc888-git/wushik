/**
 * UI 验证：桌面出牌区显示（"我出3张 → 二家用4张炸压" 的场景）
 *
 * 用户反馈：我出 3 个 10，二家出 4 个 9 压上来，那 4 个 9 显示不全。
 * 修法：中央永远摆"当前最大的一手牌"（大号牌），被压下去的淡化摆在各自面前。
 *
 * 断言：
 *  1. 二家出 4 个 9 后，中央（#playedMain）是那 4 张大牌，且【完整可见】（没被容器裁掉）
 *  2. 中央有归属标签"二家 · 4张…炸"
 *  3. 我的 3 个 10 被压后 → 在我面前（#playedMine）淡化显示（带 .beaten）
 *  4. 二家座位前的小牌是"当前最大" → 不带 .beaten
 *
 * 跑法：NODE_PATH=<playwright node_modules> node test/table-ui.cjs http://localhost:8099
 */
const { chromium } = require('playwright-core');

const URL = process.argv[2] || 'http://localhost:8099';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console.error] ' + m.text()); });

  let bad = 0;
  const ok = (m) => console.log('✓ ' + m);
  const fail = (m) => { bad++; console.error('✗ ' + m); };

  await page.goto(URL + '?fast=25', { waitUntil: 'networkidle' });
  await page.click('#btnSolo');
  await page.waitForTimeout(700);
  if (await page.locator('#modalDice.show').count()) {
    await page.click('#btnRollDice');
    await page.waitForSelector('#modalDice.show', { state: 'detached', timeout: 10000 });
  }
  ok('进牌桌');

  // 构造场景：我（座位0）出 3 个 10 → 二家（座位2）出 4 个 9 黑炸压过
  const built = await page.evaluate(() => {
    const UI = window.__wushik;
    const g = UI.game;
    const mk = (r, s, i) => ({ uid: 'x' + r + '_' + s + '_' + i, r, s, copy: i });
    // 我：3 个 10（10♠ 10♥ 10♦）+ 若干散牌
    g.hands[0] = [mk(10, 3, 0), mk(10, 2, 1), mk(10, 1, 2), mk(3, 0, 0), mk(4, 0, 0)];
    // 二家：4 个 9 全黑（♠♣）→ 4 张黑炸
    g.hands[2] = [mk(9, 3, 0), mk(9, 3, 1), mk(9, 0, 2), mk(9, 0, 3), mk(6, 0, 0)];
    g.trickCards = [];
    g.lastPlay = null;
    g.passes.clear();
    UI.trickPlays = {};

    g.turn = 0;
    const okMine = g.applyAction({ seat: 0, type: 'play', uids: g.hands[0].slice(0, 3).map((c) => c.uid) });
    if (!okMine) return { err: '我出 3 张 10 失败' };
    UI.trickPlays[0] = g.lastPlay.combo;

    g.turn = 2; // 直接让二家跟牌（跳过座位1）
    const okBomb = g.applyAction({ seat: 2, type: 'play', uids: g.hands[2].slice(0, 4).map((c) => c.uid) });
    if (!okBomb) return { err: '二家出 4 个 9 失败（应能压过 3 个 10）' };
    UI.trickPlays[2] = g.lastPlay.combo;

    UI.renderAll();
    return { ok: true, topType: g.lastPlay.combo.type, topSeat: g.lastPlay.seat, topLabel: g.lastPlay.combo.label };
  });

  if (built.err) { fail(built.err); await browser.close(); process.exit(1); }
  ok(`场景构造成功：座位${built.topSeat} 用 ${built.topLabel}（${built.topType}）压过我的 3 个 10`);

  // 1. 中央显示的应是二家的 4 张大牌
  const main = await page.evaluate(() => {
    const box = document.getElementById('playedMain');
    const cards = [...box.querySelectorAll('.card')];
    const ownerEl = document.getElementById('playedOwner');
    return {
      count: cards.length,
      rects: cards.map((c) => { const r = c.getBoundingClientRect(); return { x: r.x, w: r.width, h: r.height, right: r.right }; }),
      owner: ownerEl.textContent,
      ownerShown: ownerEl.classList.contains('show'),
      boxRect: (() => { const r = box.getBoundingClientRect(); return { x: r.x, right: r.right }; })(),
    };
  });
  if (main.count !== 4) fail(`中央应显示 4 张牌，实际 ${main.count} 张`);
  else ok('中央显示 4 张大牌（二家的炸）');

  // 2. 归属标签
  if (!main.ownerShown || !/二家/.test(main.owner)) fail(`中央归属标签不对：${JSON.stringify(main.owner)}`);
  else ok(`中央归属标签：${main.owner}`);

  // 3. 关键断言：4 张牌完整可见、没被容器裁掉（宽高正常 + 在容器横向范围内 + 在视口内）
  const clipped = main.rects.filter((r) => r.w < 40 || r.h < 60 || r.x < main.boxRect.x - 1 || r.right > main.boxRect.right + 1);
  if (clipped.length) fail(`有 ${clipped.length} 张牌被裁/变形：${JSON.stringify(clipped)}`);
  else ok('4 张牌全部完整可见（宽高正常、未超出容器被裁）');

  // 4. 我的 3 个 10 被压后 → 在我面前淡化显示
  const mine = await page.evaluate(() => {
    const box = document.getElementById('playedMine');
    const cards = [...box.querySelectorAll('.card')];
    return {
      count: cards.length,
      beaten: cards.filter((c) => c.classList.contains('beaten')).length,
      mini: cards.filter((c) => c.classList.contains('mini')).length,
    };
  });
  if (mine.count !== 3) fail(`我面前应显示我出的 3 张牌，实际 ${mine.count} 张`);
  else if (mine.beaten !== 3) fail('我被压下去的 3 张牌应带淡化样式 .beaten');
  else ok('我的 3 个 10 被压后 → 在我面前淡化显示');

  // 5. 二家座位前的牌是"当前最大" → 不淡化
  const seat = await page.evaluate(() => {
    const box = document.getElementById('played2');
    const cards = [...box.querySelectorAll('.card')];
    return { count: cards.length, beaten: cards.filter((c) => c.classList.contains('beaten')).length };
  });
  if (seat.count !== 4) fail(`二家座位前应显示 4 张牌，实际 ${seat.count} 张`);
  else if (seat.beaten !== 0) fail('当前最大的一手在座位前不应被淡化');
  else ok('二家座位前 4 张为当前最大 → 不淡化');

  await page.screenshot({ path: 'test/shot-table.png' });
  if (errors.length) fail('页面报错：' + errors.join(' | '));
  else ok('无 JS 报错');

  await browser.close();
  console.log(bad ? '\n桌面显示验证：有失败项' : '\n桌面显示验证：全部通过');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试脚本自己挂了：', e.message); process.exit(1); });
