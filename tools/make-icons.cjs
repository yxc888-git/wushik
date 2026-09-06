/**
 * 生成 PWA / APK 用的图标（192 / 512 / 苹果 180）
 * 做法：用浏览器把一段 HTML 画好再截图 —— 比手写图片编码器靠谱得多
 *
 * 跑法：NODE_PATH=<playwright node_modules> node tools/make-icons.cjs
 */
const { chromium } = require('playwright-core');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.resolve(__dirname, '..');

const HTML = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;
    background:#0b2718;font-family:"Helvetica Neue",Arial,"Microsoft YaHei",sans-serif}
  .box{width:512px;height:512px;border-radius:96px;
    background:linear-gradient(165deg,#1a6b46,#0a2e21 60%,#072015);
    border:6px solid rgba(232,196,106,.55);
    box-shadow:inset 0 0 60px rgba(0,0,0,.5), 0 12px 30px rgba(0,0,0,.45);
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px}
  .cards{display:flex;gap:14px;align-items:center}
  .c{width:96px;height:132px;background:linear-gradient(160deg,#fffdf8,#eee7d8);
    border-radius:11px;border:2px solid #cdc5b4;display:flex;align-items:center;justify-content:center;
    font-weight:900;font-size:52px;box-shadow:0 6px 14px rgba(0,0,0,.4);color:#1a1a1a;letter-spacing:-2px}
  .c.r{color:#d02c2c}
  .c.k{font-size:46px}
  .title{color:#e8c46a;font-size:44px;font-weight:900;letter-spacing:8px;text-shadow:0 3px 8px rgba(0,0,0,.5)}
  .sub{color:#9fc4b3;font-size:22px;letter-spacing:4px;margin-top:-14px}
</style>
<div class="box">
  <div class="cards">
    <div class="c r">5</div>
    <div class="c">10</div>
    <div class="c r k">K</div>
  </div>
  <div class="title">五十K</div>
  <div class="sub">郑州 · 见张乎</div>
</div>`;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const sizes = [
    { file: 'icon-192.png', size: 192 },
    { file: 'icon-512.png', size: 512 },
    { file: 'apple-touch-icon.png', size: 180 },
  ];
  for (const s of sizes) {
    const page = await browser.newPage({ viewport: { width: s.size, height: s.size }, deviceScaleFactor: 1 });
    await page.setContent(HTML, { waitUntil: 'load' });
    await page.waitForTimeout(200);
    // 把 512 的画布拉满整个视口（图标要铺满，圆角由系统加遮罩）
    await page.evaluate((size) => {
      const box = document.querySelector('.box');
      box.style.transform = `scale(${size / 512})`;
      box.style.transformOrigin = 'center center';
      document.body.style.background = 'transparent';
    }, s.size);
    await page.screenshot({ path: path.join(OUT, s.file), omitBackground: true });
    await page.close();
    console.log('✓ 生成 ' + s.file + ' (' + s.size + '×' + s.size + ')');
  }
  await browser.close();
})().catch((e) => { console.error('生成失败：', e.message); process.exit(1); });
