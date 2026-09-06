const { chromium } = require('C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node_modules/playwright-core');
const fs = require('fs');
const creds = fs.readFileSync((process.env.USERPROFILE || 'C:/Users/Administrator') + '/.git-credentials', 'utf8');
const m = creds.match(/https:\/\/([^:]+):([^@]+)@github\.com/);
const user = decodeURIComponent(m[1]); const pass = decodeURIComponent(m[2]);
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const log = (...a) => console.log('[del3]', ...a);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await (await browser.newContext({ locale: 'en-US' })).newPage();
  await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' });
  await page.fill('#login_field', user);
  await page.fill('#password', pass);
  await page.click('input[name="commit"]');
  await page.waitForTimeout(4000);

  await page.goto('https://github.com/settings/tokens', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const link = page.locator('a[href^="/settings/tokens/"]:has-text("wushik-deploy")').first();
  if (!(await link.count())) { log('LINK_NOT_FOUND'); await browser.close(); process.exit(1); }
  const href = await link.getAttribute('href');
  log('token href=' + href);

  await page.goto('https://github.com' + href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const del = page.locator('button:has-text("Delete"), a:has-text("Delete")').first();
  if (!(await del.count())) { log('NO_DELETE_BTN'); await page.screenshot({ path: 'tools/del_fail.png' }); await browser.close(); process.exit(1); }
  await del.evaluate(el => el.click());
  await page.waitForTimeout(1200);

  const confirm = page.locator('button:has-text("I understand, delete this token")').first();
  if (await confirm.count()) { await confirm.evaluate(el => el.click()); log('confirm clicked'); }
  else { log('NO_CONFIRM'); await page.screenshot({ path: 'tools/del_fail.png' }); await browser.close(); process.exit(1); }
  await page.waitForTimeout(2000);

  await page.goto('https://github.com/settings/tokens', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const still = await page.locator('a[href^="/settings/tokens/"]:has-text("wushik-deploy")').count();
  log('remaining wushik-deploy links=' + still);
  log(still === 0 ? 'DELETED_OK' : 'STILL_PRESENT');
  await browser.close();
})();
