/**
 * 可见 Chrome 打开游戏窗口（常驻，不关浏览器）
 * 跑法：NODE_PATH=<playwright node_modules> node open-game.cjs
 */
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    args: ['--start-maximized', '--no-first-run', '--no-default-browser-check'],
  });
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();
  await page.goto('http://localhost:8080/', { waitUntil: 'networkidle' });
  console.log('GAME WINDOW OPEN: http://localhost:8080/');
  // 常驻保活，浏览器窗口留给用户玩（绝不 close）
  setInterval(() => {}, 1 << 30);
})().catch((e) => { console.error('LAUNCH FAIL:', e.message); process.exit(1); });
