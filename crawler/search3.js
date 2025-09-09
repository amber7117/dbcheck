const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const Cookie = require('../models/cookie');
const login = require('./login');

puppeteer.use(StealthPlugin());

async function ensureCookies(page) {
  let dbCookies = await Cookie.findOne({ name: "zowner" });

  if (!dbCookies) {
    console.log("⚠️ No cookies found, logging in...");
    await login();
    dbCookies = await Cookie.findOne({ name: "zowner" });
  }

  await page.setCookie(...dbCookies.cookies);

  // verify session still valid
  await page.goto('https://zowner.info/index.php', { waitUntil: 'networkidle2' });
  if (page.url().includes('login.php')) {
    console.log("⚠️ Cookies expired, re-login...");
    await login();
    dbCookies = await Cookie.findOne({ name: "zowner" });
    await page.setCookie(...dbCookies.cookies);
    await page.goto('https://zowner.info/index.php', { waitUntil: 'networkidle2' });
  }
}

async function search(queryText) {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await ensureCookies(page);

    // choose category
    let category = 3;
    if (/^\d{12,18}$/.test(queryText)) category = 1;
    else if (/^\d{11}$/.test(queryText)) category = 4;

    // fill form
    await page.evaluate((term, cat) => {
      const input = document.querySelector('input[name="keyword"]');
      const select = document.querySelector('select[name="category"]');
      if (input && select) {
        input.value = term;
        select.value = cat.toString();
        document.querySelector('input[type="submit"]').click();
      }
    }, queryText, category);

    await page.waitForSelector('#dataTable tbody tr, .no-results', { timeout: 20000 });

    const results = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#dataTable tbody tr'));
      const seen = new Set();
      const items = [];

      rows.forEach(row => {
        const cols = row.querySelectorAll('td');
        if (cols.length >= 5) {
          const idCard = cols[0].innerText.trim();
          const name = cols[1].innerText.trim();
          const oldId = cols[2].innerText.trim();
          const address = cols[3].innerText.trim();
          const phone = cols[4].innerText.trim();

          const finalId = idCard && idCard !== 'NULL' ? idCard : (oldId && oldId !== 'NULL' ? oldId : '');
          if (!finalId || !phone) return;

          const key = `${finalId}-${phone}`;
          if (seen.has(key)) return;
          seen.add(key);

          items.push({ name, idCard: finalId, phone, address });
        }
      });
      return items;
    });

    await browser.close();
    return results;
  } catch (err) {
    if (browser) await browser.close();
    throw err;
  }
}

module.exports = search;

