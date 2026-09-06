/**
 * UI 验证：音效（Web Audio 现场合成，不依赖音频文件）
 *
 * 验证点：
 *  1. 页面能创建 AudioContext，出牌/过牌真的触发了发声（osc / 噪声源被 start）
 *  2. 各音效名都能播且不抛错
 *  3. 静音开关：关掉后不再发声，刷新后状态保持（localStorage）
 *
 * 跑法：NODE_PATH=<playwright node_modules> node test/sound-ui.cjs http://localhost:8099
 */
const { chromium } = require('playwright-core');

const URL = process.argv[2] || 'http://localhost:8099';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console.error] ' + m.text()); });

  let bad = 0;
  const ok = (m) => console.log('✓ ' + m);
  const fail = (m) => { bad++; console.error('✗ ' + m); };

  // 在页面加载前挂钩 AudioContext，统计"真的发声了几次"
  await page.addInitScript(() => {
    window.__sfx = { ctx: 0, started: 0 };
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const wrap = (proto, name) => {
      const orig = proto[name];
      proto[name] = function (...a) {
        const node = orig.apply(this, a);
        const s = node.start.bind(node);
        node.start = (...b) => { window.__sfx.started++; return s(...b); };
        return node;
      };
    };
    wrap(AC.prototype, 'createOscillator');
    wrap(AC.prototype, 'createBufferSource');
    const OrigAC = AC;
    window.AudioContext = function (...a) { window.__sfx.ctx++; return new OrigAC(...a); };
    window.AudioContext.prototype = OrigAC.prototype;
  });

  await page.goto(URL + '?fast=25', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('wushik_sound')); // 默认开
  await page.reload({ waitUntil: 'networkidle' });
  ok('页面加载完成（音效默认开）');

  // 1. 出各种音效都不抛错
  const names = ['play', 'pass', 'bomb', 'bell', 'joker', 'tick', 'turn', 'deal', 'win', 'lose', 'coin', 'dice'];
  const before = await page.evaluate(() => window.__sfx.started);
  await page.evaluate((list) => {
    list.forEach((n) => window.__wushik.sound.play(n));
  }, names);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__sfx.started);
  if (after - before < names.length) fail(`${names.length} 种音效只发出 ${after - before} 次声源`);
  else ok(`${names.length} 种音效全部发声（共起振 ${after - before} 个声源）`);

  // 2. 实际对局中：发牌 + 出牌 都有声音
  await page.evaluate(() => { window.__sfx.started = 0; });
  await page.click('#btnSolo');
  await page.waitForTimeout(800);
  if (await page.locator('#modalDice.show').count()) {
    await page.click('#btnRollDice');
    await page.waitForSelector('#modalDice.show', { state: 'detached', timeout: 10000 });
  }
  await page.waitForTimeout(2500); // 让 AI 打几手
  const inGame = await page.evaluate(() => window.__sfx.started);
  if (inGame < 3) fail(`开局到打了 2 秒只发出 ${inGame} 次声源（发牌+出牌应有多次）`);
  else ok(`实际对局有声音：2 秒内发声源 ${inGame} 次`);

  // 3. 静音开关
  await page.click('#btnSound');
  await page.waitForTimeout(150);
  const muted = await page.evaluate(() => ({
    text: document.getElementById('btnSound').textContent,
    menu: document.getElementById('mSound').textContent,
    stored: localStorage.getItem('wushik_sound'),
    count: window.__sfx.started,
  }));
  if (muted.stored !== 'off') fail('静音状态没写进 localStorage');
  else if (!/静音/.test(muted.text) || !/关/.test(muted.menu)) fail(`按钮文案没同步：${muted.text} / ${muted.menu}`);
  else ok(`静音开关生效：顶栏「${muted.text}」、菜单「${muted.menu}」`);

  // 静音后不应再发声
  await page.waitForTimeout(2000);
  const afterMute = await page.evaluate(() => window.__sfx.started);
  if (afterMute > muted.count) fail(`静音后仍在发声（新增 ${afterMute - muted.count} 次）`);
  else ok('静音后不再发声');

  // 4. 刷新后保持静音
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const reloaded = await page.evaluate(() => document.getElementById('btnSound').textContent);
  if (!/静音/.test(reloaded)) fail(`刷新后静音状态丢失：${reloaded}`);
  else ok('刷新后仍保持静音（localStorage 记住了）');

  if (errors.length) fail('页面报错：' + errors.join(' | '));
  else ok('无 JS 报错');

  await browser.close();
  console.log(bad ? '\n音效验证：有失败项' : '\n音效验证：全部通过');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试脚本自己挂了：', e.message); process.exit(1); });
