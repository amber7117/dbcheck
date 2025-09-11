const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const fs = require('fs').promises;
const path = require('path');
const Cookie = require('../models/cookie');
const login = require('./login');

puppeteer.use(StealthPlugin());

// Configuration constants
const CONFIG = {
  BROWSER: {
    ARGS: chromium.args,
    DEFAULT_VIEWPORT: chromium.defaultViewport,
    HEADLESS: chromium.headless,
  },
  TIMEOUTS: {
    RETRY_DELAY: 1000,
    PAGE_WAIT: 80000,
    NETWORK_IDLE: 'networkidle2',
  },
  URLS: {
    BASE: 'https://zowner.info/index.php',
    LOGIN: 'login.php',
  },
  CATEGORIES: {
    ID_CARD: 1,
    NAME: 3,
    PHONE: 4,
  },
  SELECTORS: {
    KEYWORD_INPUT: 'input[name="keyword"]',
    CATEGORY_SELECT: 'select[name="category"]',
    SUBMIT_BUTTON: 'input[type="submit"]',
    DATA_ROWS: '#dataTable tbody tr',
    NO_RESULTS: '.no-results',
    RESULT_SELECTOR: '#dataTable tbody tr, .no-results',
  },
  FILE: {
    MAX_OUTPUT_LENGTH: 4000,
    TEMP_DIR: '/tmp',
  }
};

let browserInstance = null;

/**
 * Get or create browser instance with proper configuration
 */
async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      args: CONFIG.BROWSER.ARGS,
      defaultViewport: CONFIG.BROWSER.DEFAULT_VIEWPORT,
      executablePath: await chromium.executablePath(),
      headless: CONFIG.BROWSER.HEADLESS,
    });
  }
  return browserInstance;
}

/**
 * Execute function with exponential backoff retry logic
 */
async function withRetries(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(res => setTimeout(res, CONFIG.TIMEOUTS.RETRY_DELAY * (i + 1)));
    }
  }
}

/**
 * Transform database cookies to puppeteer format
 */
function transformCookies(dbCookies) {
  return dbCookies.cookies.map(c => ({
    name: c.name || c.key,
    value: c.value,
    domain: c.domain || "zowner.info",
    path: c.path || "/",
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: c.sameSite || "Lax"
  }));
}

/**
 * Handle login and cookie refresh
 */
async function handleLogin() {
  console.log("⚠️ Cookies expired, re-login...");
  await login();
  const dbCookies = await Cookie.findOne({ name: "zowner" });
  return transformCookies(dbCookies);
}

/**
 * Ensure valid cookies are set and user is authenticated
 */
async function ensureCookies(page) {
  let dbCookies = await Cookie.findOne({ name: "zowner" });

  if (!dbCookies) {
    console.log("⚠️ No cookies found, logging in...");
    await login();
    dbCookies = await Cookie.findOne({ name: "zowner" });
  }

  const validCookies = transformCookies(dbCookies);
  await page.setCookie(...validCookies);

  await page.goto(CONFIG.URLS.BASE, { waitUntil: CONFIG.TIMEOUTS.NETWORK_IDLE });
  
  if (page.url().includes(CONFIG.URLS.LOGIN)) {
    const newValidCookies = await handleLogin();
    await page.setCookie(...newValidCookies);
    await page.goto(CONFIG.URLS.BASE, { waitUntil: CONFIG.TIMEOUTS.NETWORK_IDLE });
  }
}

/**
 * Generate timestamp string for file naming
 */
function nowTs() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}

/**
 * Determine search category based on query text
 */
function getSearchCategory(queryText) {
  if (!/^\d+$/.test(queryText)) {
    return CONFIG.CATEGORIES.NAME; // default: name
  }
  
  return queryText.length === 12 
    ? CONFIG.CATEGORIES.ID_CARD // 身份证
    : CONFIG.CATEGORIES.PHONE; // 电话号码
}

/**
 * Execute search on the page
 */
async function doSearch(page, queryText) {
  const category = getSearchCategory(queryText);

  await page.evaluate((term, cat, selectors) => {
    const input = document.querySelector(selectors.KEYWORD_INPUT);
    const select = document.querySelector(selectors.CATEGORY_SELECT);
    if (input && select) {
      input.value = term;
      select.value = cat.toString();
      document.querySelector(selectors.SUBMIT_BUTTON).click();
    }
  }, queryText, category, CONFIG.SELECTORS);

  await page.waitForSelector(CONFIG.SELECTORS.RESULT_SELECTOR, { 
    timeout: CONFIG.TIMEOUTS.PAGE_WAIT 
  });

  return await page.evaluate((selectors) => {
    const rows = Array.from(document.querySelectorAll(selectors.DATA_ROWS));
    const items = [];

    rows.forEach(row => {
      const cols = row.querySelectorAll('td');
      if (cols.length < 5) return;

      const [idCardCol, nameCol, oldIdCol, addressCol, phoneCol] = cols;
      
      const idCard = idCardCol.innerText.trim();
      const name = nameCol.innerText.trim();
      const oldId = oldIdCol.innerText.trim();
      const address = addressCol.innerText.trim();
      const phone = phoneCol.innerText.trim();

      const finalId = (idCard && idCard !== 'NULL') 
        ? idCard 
        : (oldId && oldId !== 'NULL' ? oldId : '');

      if (!finalId) return;

      items.push({
        name: name || 'Unknown',
        idCard: finalId,
        phone: phone,
        address: address || 'Unknown'
      });
    });
    
    return items;
  }, CONFIG.SELECTORS);
}

/**
 * Group search results by person (idCard)
 */
function groupResults(results) {
  const grouped = new Map();

  results.forEach(item => {
    const id = item.idCard;
    if (!grouped.has(id)) {
      grouped.set(id, {
        name: item.name,
        idCard: item.idCard,
        phones: new Set(),
        addresses: new Set()
      });
    }
    
    const person = grouped.get(id);
    if (item.phone && item.phone !== 'NULL') {
      person.phones.add(item.phone);
    }
    if (item.address && item.address !== 'NULL') {
      person.addresses.add(item.address);
    }
  });

  return Array.from(grouped.values()).map(person => ({
    ...person,
    phones: Array.from(person.phones),
    addresses: Array.from(person.addresses)
  }));
}

/**
 * Format search results into readable output
 */
function formatResults(results) {
  let output = 'IC NO.      | NAME.          | OLD IC NO. |            ADDRESS           | PHONE\n';
  output += '-------------------------------------------------------------------------------------\n';
  
  results.reverse().forEach(item => {
    const addresses = item.addresses.join(', ');
    const phones = item.phones.join(', ');
    output += `${item.idCard || ''} | ${item.name} | | ${addresses} | ${phones}\n`;
  });
  
  return output;
}

/**
 * Save results to file if output is too long
 */
async function saveResultsToFile(output) {
  const fileName = `search_results_${nowTs()}.txt`;
  const filePath = path.join(CONFIG.FILE.TEMP_DIR, fileName);
  await fs.writeFile(filePath, output);
  console.log(`Results saved to ${filePath}`);
  return `The result is too long. It has been saved to a file: ${filePath}`;
}

/**
 * Main search function
 */
async function search(queryText) {
  let page;
  
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await ensureCookies(page);

    const results = await withRetries(() => doSearch(page, queryText));

    if (!results || results.length === 0) {
      return 'No results found.';
    }

    const groupedResults = groupResults(results);
    const output = formatResults(groupedResults);

    return output.length > CONFIG.FILE.MAX_OUTPUT_LENGTH
      ? await saveResultsToFile(output)
      : output;

  } catch (err) {
    console.error(`[SEARCH_ERROR] Query: "${queryText}" - Error: ${err.stack}`);
    return 'An error occurred while searching. Please try again later.';
  } finally {
    if (page) await page.close();
  }
}

module.exports = search;
