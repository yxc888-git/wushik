/**
 * UI 端到端验证：自由出牌（用户截图场景复现）
 *  1. 进单机 → 掷骰子 → 等轮到我自由出牌
 *  2. 找手里张数最多的点数，选 5 张同点（必不成牌型，模拟"选 5 张 5"）
 *  3. 断言：出牌按钮【未禁用】（修复前是置灰的）
 *  4. 点出牌 → 断言：出牌成功，桌面显示「5张自由出」，手牌 -5
 *
 * 跑法：NODE_PATH=<playwright node_modules> node test/freeplay-ui.cjs http://localhost:8099
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
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console.error] ' + m.text()); });

  const fail = (msg) => { console.error('✗ ' + msg); process.exitCode = 1; };
  const ok = (msg) => console.log('✓ ' + msg);

  await page.goto(URL + '?fast=25', { waitUntil: 'networkidle' });
  ok('首页加载完成');

  await page.click('#btnSolo');
  await page.waitForTimeout(800);

  // 掷骰子弹窗
  if (await page.locator('#modalDice.show').count()) {
    await page.click('#btnRollDice');
    await page.waitForSelector('#modalDice.show', { state: 'detached', timeout: 10000 });
    ok('掷骰子定首发完成');
  }

  // 等轮到我且是自由出牌。轮到我跟牌时先用真实按钮自动处理掉
  // （见张乎下点「提示」再点「出牌」；没牌可压点「不出」），游戏才能继续转。
  // 顺带断言：「不出」按钮的禁用状态与 canPass 一致（能压必须出 → 置灰）。
  let passBtnChecks = 0;
  let gotFreeTurn = false;
  for (let i = 0; i < 400 && !gotFreeTurn; i++) {
    const st = await page.evaluate(() => {
      const UI = window.__wushik;
      if (!UI || !UI.game) return { st: 'nogame' };
      if (UI.game.phase === 'finished') return { st: 'finished' };
      let mine = false;
      if (UI.game.turn === UI.mySeat) {
        mine = UI.game.isFreeTurn(UI.mySeat) ? 'free' : 'follow';
      }
      return { st: 'playing', mine };
    }).catch((e) => ({ st: 'evalerr', err: e.message }));
    if (st.st === 'evalerr') { console.log('  [poll err] ' + st.err); }

    if (st.st === 'finished') {
      await page.click('#btnNextRound');
      await page.waitForTimeout(400);
      continue;
    }
    if (st.mine === 'free') { gotFreeTurn = true; break; }
    if (st.mine === 'follow') {
      const s = await page.evaluate(() => {
        const UI = window.__wushik;
        return {
          passDisabled: document.getElementById('btnPass').disabled,
          hasBeats: UI.game.legalMoves(UI.mySeat).length > 0,
        };
      });
      if (s.hasBeats) {
        if (!s.passDisabled) fail('见张乎：能压时「不出」按钮应禁用，实际可点');
        else { passBtnChecks++; }
        // 真实按钮操作：提示自动选一手能压的 → 出牌
        await page.click('#btnHint');
        await page.waitForTimeout(150);
        const playOff = await page.evaluate(() => document.getElementById('btnPlay').disabled);
        if (playOff) fail('提示选中能压的牌后，出牌按钮仍禁用');
        await page.click('#btnPlay');
      } else {
        if (s.passDisabled) fail('没牌可压时「不出」按钮应可点，实际被禁用');
        await page.click('#btnPass');
      }
      await page.waitForTimeout(400);
      continue;
    }
    await page.waitForTimeout(150);
  }
  if (!gotFreeTurn) {
    fail('没等到我自由出牌；页面错误：' + (errors.join(' | ') || '无') +
      '；最后状态：' + JSON.stringify(await page.evaluate(() => {
        const UI = window.__wushik;
        return UI && UI.game ? { phase: UI.game.phase, turn: UI.game.turn, busy: UI.busy } : null;
      }).catch(() => null)));
    await browser.close();
    return;
  }
  ok('轮到我自由出牌（跟牌回合已自动处理 ' + (passBtnChecks > 0 ? passBtnChecks + ' 次见张乎按钮校验通过' : '') + '）');

  // 在页面里找"5 张同点"的选法（模拟用户选 5 张 5；找不到就用 5 张互不相同的散牌）
  const uids = await page.evaluate(() => {
    const UI = window.__wushik;
    const hand = UI.game.hands[UI.mySeat];
    const byRank = new Map();
    for (const c of hand) {
      if (!byRank.has(c.r)) byRank.set(c.r, []);
      byRank.get(c.r).push(c.uid);
    }
    let pick = null;
    for (const [, list] of byRank) {
      if (list.length >= 5) { pick = list.slice(0, 5); break; } // 5张同点：必不成牌型（非炸）
    }
    if (!pick) {
      // 兜底：5 张互不相同的点数
      const seen = new Set();
      pick = [];
      for (const c of hand) {
        if (!seen.has(c.r) && !seen.has(c.r - 1) && !seen.has(c.r + 1)) {
          seen.add(c.r); pick.push(c.uid);
          if (pick.length === 5) break;
        }
      }
    }
    return pick;
  });
  if (uids.length !== 5) { fail('没凑出 5 张杂牌选法，实际 ' + uids.length); await browser.close(); return; }
  ok('已确定 5 张杂牌选法（' + uids.length + ' 张，点页面里的牌）');

  // 点选这 5 张牌（走真实 DOM 点击，模拟真人操作）
  // 手牌是叠着摆的（右半被下一张盖住），要点左边缘露出的部分
  for (const uid of uids) {
    await page.click(`#hand .card[data-uid="${uid}"]`, { position: { x: 10, y: 50 } });
  }
  await page.waitForTimeout(150);

  // 关键断言 1：出牌按钮必须已启用（修复前：detect 为 null → 置灰，用户截图的问题）
  const playDisabled = await page.evaluate(() => document.getElementById('btnPlay').disabled);
  if (playDisabled) {
    fail('5 张杂牌选中后出牌按钮仍是禁用 —— 自由出牌没生效');
    await page.screenshot({ path: 'test/shot-freeplay-fail.png' });
    await browser.close();
    return;
  }
  ok('出牌按钮已启用（修复前这里是置灰的）');

  // 关键断言 2：「不出」按钮在自由出牌时必须禁用（领出不能过）
  const passDisabled = await page.evaluate(() => document.getElementById('btnPass').disabled);
  if (!passDisabled) fail('自由出牌时「不出」按钮应禁用（领出不能过）');
  else ok('「不出」按钮已禁用（领出不能过）');

  // 出牌
  const before = await page.evaluate(() => window.__wushik.game.hands[window.__wushik.mySeat].length);
  await page.click('#btnPlay');
  await page.waitForTimeout(600);

  // 关键断言 3：出牌成功，桌面按「N张自由出」处理，手牌 -5
  const after = await page.evaluate(() => {
    const UI = window.__wushik;
    const tp = UI.trickPlays[UI.mySeat];
    return {
      handLen: UI.game.hands[UI.mySeat].length,
      type: tp && tp !== 'pass' ? tp.type : null,
      label: tp && tp !== 'pass' ? tp.label : null,
    };
  });
  if (after.handLen !== before - 5) {
    fail(`出牌没成功：手牌 ${before} → ${after.handLen}`);
    await page.screenshot({ path: 'test/shot-freeplay-fail.png' });
  } else if (after.type !== 'FREE') {
    fail(`出牌成功但类型是 ${after.type}，应为 FREE`);
  } else {
    ok(`5 张杂牌一手甩出成功：桌面显示「${after.label}」，手牌 ${before} → ${after.handLen}`);
  }

  // 收尾：等这局打完或直接退出（不 close 用户窗口的问题不存在——这是无头测试浏览器）
  if (errors.length) fail('页面报错：\n' + errors.join('\n'));
  else ok('无 JS 报错、无 404');

  await browser.close();
  console.log(process.exitCode ? '\n自由出牌 UI 验证：有失败项' : '\n自由出牌 UI 验证：全部通过');
})().catch((e) => { console.error('测试脚本自己挂了：', e.message); process.exit(1); });
