const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const fs = require('fs').promises;
const path = require('path');
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
function nowTs() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}

async function search(queryText) {
  let browser;
  try {
    // Add a 1-second delay to prevent spamming
    await new Promise(resolve => setTimeout(resolve, 1000));
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await ensureCookies(page);

    // --- choose category ---
    let category = 3; // default: name
    if (/^\d+$/.test(queryText)) {
      if (queryText.length === 12) {
        category = 1; // 身份证
      } else {
        category = 4; // 电话号码
      }
    }

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

    if (!results || results.length === 0) {
      return 'No results found.';
    }

    // Format the results into a string only if there are results
    let output = 'IC NO. | NAME | OLD IC NO. | ADDRESS | PHONE\n';
    output += '--------------------------------------------------\n';
    results.forEach(item => {
      output += `${item.idCard || ''} | ${item.name} | | ${item.address} | ${item.phone}\n`;
    });

    // If the output is too long, save to a file
    if (output.length > 4000) { // Telegram message limit is 4096
      const fileName = `search_results_${nowTs()}.txt`;
      const filePath = path.join('/tmp', fileName); // Use /tmp for Render
      await fs.writeFile(filePath, output);
      console.log(`Results saved to ${filePath}`);
      return `The result is too long. It has been saved to a file: ${filePath}`;
    } else {
      return output;
    }

  } catch (err) {
    if (browser) await browser.close();
    console.error('An error occurred during the search:', err);
    return 'An error occurred while searching. Please try again later.';
  }
}

module.exports = search;
