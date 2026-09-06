const { chromium } = require('playwright-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'https://d1ddaec81b170834-222-137-249-158.serveousercontent.com';
(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const p = await b.newPage();
  await p.goto(URL, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => console.log('goto:', e.message));
  await p.waitForTimeout(2500);
  const hasBtn = await p.locator('#btnSolo').count();
  const title = await p.title();
  const bodyText = (await p.evaluate(() => document.body.innerText)).slice(0, 400).replace(/\s+/g, ' ');
  console.log('TITLE:', title);
  console.log('hasBtnSolo:', hasBtn);
  console.log('BODY:', bodyText);
  await b.close();
})().catch((e) => { console.error(e); process.exit(2); });
