const { chromium } = require('C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node_modules/playwright-core');
const fs = require('fs');

const HOME = process.env.USERPROFILE || 'C:/Users/Administrator';
const credsPath = HOME + '/.git-credentials';
const creds = fs.readFileSync(credsPath, 'utf8');
const m = creds.match(/https:\/\/([^:]+):([^@]+)@github\.com/);
if (!m) { console.log('NO_CREDS'); process.exit(1); }
const user = decodeURIComponent(m[1]);
const pass = decodeURIComponent(m[2]);

const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const log = (...a) => console.log('[gen]', ...a);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ locale: 'en-US' });
  const page = await ctx.newPage();
  try {
    log('goto login');
    await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.fill('#login_field', user);
    await page.fill('#password', pass);
    await page.click('input[name="commit"]');
    await page.waitForTimeout(4000);

    let url = page.url();
    log('after login url=' + url);
    if (url.includes('two-factor') || await page.locator('text=Two-factor authentication').count()) {
      log('2FA_REQUIRED');
      await page.screenshot({ path: 'tools/2fa.png' });
      await browser.close();
      process.exit(2);
    }
    if (url.includes('/login') && !url.includes('github.com/sessions')) {
      log('LOGIN_FAILED url=' + url);
      await page.screenshot({ path: 'tools/login_fail.png' });
      await browser.close();
      process.exit(3);
    }
    log('LOGGED_IN');

    await page.goto('https://github.com/settings/tokens/new', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const noteSel = ['input#oauth_access_description', 'input[name="oauth_access[description]"]'];
    let noted = false;
    for (const s of noteSel) { if (await page.locator(s).count()) { await page.fill(s, 'wushik-deploy'); noted = true; break; } }
    log('note filled=' + noted);

    const repoSel = 'input[name="oauth_access[scopes][]"][value="repo"]';
    if (await page.locator(repoSel).count()) { await page.locator(repoSel).check(); log('repo checked'); }
    else { log('repo checkbox not found, trying label'); await page.locator('label:has-text("repo")').first().click(); }

    await page.locator('button:has-text("Generate token")').first().click();
    await page.waitForTimeout(2500);

    // confirm dialog may appear ("Generate token" again)
    if (await page.locator('button:has-text("Generate token")').count()) {
      await page.locator('button:has-text("Generate token")').first().click();
      await page.waitForTimeout(2500);
    }

    let tok = '';
    const bodyText = await page.textContent('body').catch(() => '');
    let mm = bodyText && bodyText.match(/ghp_[A-Za-z0-9]{20,}/);
    if (mm) tok = mm[0];
    if (!tok) {
      const els = await page.locator('input, code, .js-copyable-copy').all();
      for (const e of els) {
        const v = (await e.inputValue().catch(() => '')) || (await e.textContent().catch(() => '')) || '';
        const x = v.match(/ghp_[A-Za-z0-9]{20,}/);
        if (x) { tok = x[0]; break; }
      }
    }

    if (tok.startsWith('ghp_')) {
      fs.writeFileSync('token.txt', tok);
      log('TOKEN_READY:' + tok);
    } else {
      log('TOKEN_NOT_FOUND');
      await page.screenshot({ path: 'tools/token_fail.png' });
    }
  } catch (e) {
    log('ERR:' + e.message);
    await page.screenshot({ path: 'tools/err.png' }).catch(() => {});
  } finally {
    await browser.close();
  }
})();
