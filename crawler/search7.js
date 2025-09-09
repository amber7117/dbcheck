const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const Cookie = require('../models/cookie');
const login = require('./login');

puppeteer.use(StealthPlugin());

// --- ensure cookies are valid and attached ---
async function ensureCookies(page) {
  let dbCookies = await Cookie.findOne({ name: "zowner" });

  if (!dbCookies) {
    console.log("⚠️ No cookies found, logging in...");
    await login();
    dbCookies = await Cookie.findOne({ name: "zowner" });
  }

  // sanitize cookies
  const validCookies = dbCookies.cookies.map(c => ({
    name: c.name || c.key,   // fallback if saved as "key"
    value: c.value,
    domain: c.domain || "zowner.info",
    path: c.path || "/",
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: c.sameSite || "Lax"
  }));

  await page.setCookie(...validCookies);

  // check if session still valid
  await page.goto('https://zowner.info/index.php', { waitUntil: 'networkidle2' });
  if (page.url().includes('login.php')) {
    console.log("⚠️ Cookies expired, re-login...");
    await login();
    dbCookies = await Cookie.findOne({ name: "zowner" });

    const newValidCookies = dbCookies.cookies.map(c => ({
      name: c.name || c.key,
      value: c.value,
      domain: c.domain || "zowner.info",
      path: c.path || "/",
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
      sameSite: c.sameSite || "Lax"
    }));

    await page.setCookie(...newValidCookies);
    await page.goto('https://zowner.info/index.php', { waitUntil: 'networkidle2' });
  }
}

// --- perform search ---
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

    // choose category (default: name)
    let category = 3;
    if (/^\d{12,18}$/.test(queryText)) category = 1;   // IC
    else if (/^\d{11}$/.test(queryText)) category = 4; // Phone

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

    // wait for results
    await page.waitForSelector('#dataTable tbody tr, .no-results', { timeout: 80000 });

    // extract data
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

          const finalId =
            idCard && idCard !== 'NULL'
              ? idCard
              : (oldId && oldId !== 'NULL' ? oldId : '');

          if (!finalId || !phone) return;

          const key = `${finalId}-${phone}`;
          if (seen.has(key)) return;
          seen.add(key);

          items.push({
            name: name || 'Unknown',
            idCard: finalId,
            phone: phone,
            address: address || 'Unknown'
          });
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

