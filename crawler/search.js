// search.js — 提交用 form.submit()，三路并行等待，软刷新与快照
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const fs = require('fs').promises;
const path = require('path');
const Cookie = require('../models/cookie');
const login = require('./login');

puppeteer.use(StealthPlugin());

/* ============== 基本配置 ============== */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const LANG_HDR = { 'Accept-Language': 'en-US,en;q=0.9' };
const BASE_URL = 'https://zowner.info/index.php';
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.CRAWLER_CONCURRENCY || '1', 10));

/* ============== 小工具 ============== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function nowTs() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}

/* ============== 全局并发（排队） ============== */
let active = 0;
const queue = [];
async function acquire() {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise((resolve) => queue.push(resolve));
  active++;
}
function release() {
  active = Math.max(0, active - 1);
  const next = queue.shift();
  if (next) next();
}

/* ============== 浏览器单例 ============== */
let BROWSER_PROMISE = null;
async function getBrowser() {
  if (!BROWSER_PROMISE) {
    BROWSER_PROMISE = puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-zygote',
        '--single-process'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });
  }
  return BROWSER_PROMISE;
}

/* ============== 重试封装 ============== */
async function withRetries(fn, { retries = 3, baseDelay = 800 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt > retries) throw e;
      const jitter = Math.floor(Math.random() * 400);
      const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
      console.warn(`⚠️ attempt ${attempt} failed: ${e.message || e}. retry in ${delay}ms`);
      await sleep(delay);
    }
  }
}

/* ============== Cookie 会话自愈 ============== */
async function ensureCookies(page) {
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders(LANG_HDR);
  try { await page.emulateTimezone('Asia/Kuala_Lumpur'); } catch (_) {}

  let dbCookies = await Cookie.findOne({ name: 'zowner' });
  if (!dbCookies) {
    console.log('⚠️ No cookies found, logging in...');
    await login();
    dbCookies = await Cookie.findOne({ name: 'zowner' });
  }

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  const validCookies = dbCookies.cookies.map((c) => ({
    name: c.name || c.key,
    value: c.value,
    domain: c.domain || 'zowner.info',
    path: c.path || '/',
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: c.sameSite || 'Lax'
  }));
  await page.setCookie(...validCookies);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
    page.reload({ waitUntil: 'networkidle2' })
  ]);

  if (page.url().includes('login.php')) {
    console.log('⚠️ Cookies expired, re-login...');
    await login();
    const fresh = await Cookie.findOne({ name: 'zowner' });
    const freshCookies = fresh.cookies.map((c) => ({
      name: c.name || c.key,
      value: c.value,
      domain: c.domain || 'zowner.info',
      path: c.path || '/',
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
      sameSite: c.sameSite || 'Lax'
    }));
    await page.setCookie(...freshCookies);
    await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
  }
}

/* ============== 提交并稳健等待（form.submit + 三路并行） ============== */
async function submitAndRobustWait(page) {
  // 直接用 form.submit()，避免点击失败
  const ok = await page.evaluate(() => {
    const input = document.querySelector('input[name="keyword"]');
    const select = document.querySelector('select[name="category"]');
    const form =
      (input && input.closest('form')) ||
      (select && select.closest('form')) ||
      document.querySelector('form');
    if (!input || !select || !form) return false;
    // 有些老页面需要显式设置 name/value 后再提交
    form.submit();
    return true;
  });
  if (!ok) throw new Error('FORM_NOT_READY');

  await Promise.race([
    // 路径1：真的发生导航
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
    // 路径2：AJAX 渲染（不导航）
    page.waitForFunction(() => {
      const t = document.querySelector('#dataTable');
      if (t && t.querySelectorAll('tbody tr').length > 0) return true;
      if (document.querySelector('.no-results')) return true;
      const wrap = document.querySelector('#dataTable_wrapper');
      if (wrap) {
        const tb = wrap.querySelector('table#dataTable') || wrap.querySelector('table');
        if (tb && tb.querySelectorAll('tbody tr').length > 0) return true;
      }
      return false;
    }, { timeout: 60000 }).catch(() => {}),
    // 路径3：被拦到登录/挑战
    page.waitForFunction(() => /login\.php|challenge|cloudflare/i.test(location.href), {
      timeout: 60000
    }).catch(() => {})
  ]);
}

/* ============== 快照（排障用，可留） ============== */
async function dumpSnapshot(page, tag = 'snap') {
  try {
    const stamp = `${tag}-${nowTs()}`;
    const dir = '/tmp'; // Render 可写目录
    const htmlPath = path.join(dir, `${stamp}.html`);
    const pngPath = path.join(dir, `${stamp}.png`);
    const html = await page.content();
    fs.writeFileSync(htmlPath, html);
    await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
    console.log(`🧾 Saved snapshot: ${htmlPath} & ${pngPath}`);
  } catch (e) {
    console.warn('snapshot failed:', e.message);
  }
}

/* ============== 单次查询 ============== */
async function doSearchOnce(page, queryText) {
  // 类目：12位纯数字→身份证；其他纯数字→电话；否则名字
  let category = 3;
  if (/^\d+$/.test(queryText)) category = queryText.length === 12 ? 1 : 4;

  // 到搜索页 & 设置默认超时
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  page.setDefaultTimeout(70000);
  page.setDefaultNavigationTimeout(70000);

  // 表单准备
  await page.waitForSelector('input[name="keyword"]', { timeout: 20000 });
  await page.waitForSelector('select[name="category"]', { timeout: 20000 });

  // 输入
  await page.$eval('input[name="keyword"]', (el) => (el.value = ''));
  await page.type('input[name="keyword"]', queryText, { delay: 8 });
  await page.select('select[name="category"]', String(category));

  // 监测429
  let got429 = false;
  const onResp = (resp) => { if (resp.status() === 429) got429 = true; };
  page.on('response', onResp);

  // 提交 + 等待
  try {
    await submitAndRobustWait(page);
  } catch (e) {
    console.warn('⚠️ submitAndRobustWait error:', e.message);
    await dumpSnapshot(page, 'after-submit-fail');
    // 软刷新再等一次
    await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
    await page.waitForFunction(() => {
      const t = document.querySelector('#dataTable');
      if (t && t.querySelectorAll('tbody tr').length > 0) return true;
      if (document.querySelector('.no-results')) return true;
      const wrap = document.querySelector('#dataTable_wrapper');
      if (wrap) {
        const tb = wrap.querySelector('table#dataTable') || wrap.querySelector('table');
        if (tb && tb.querySelectorAll('tbody tr').length > 0) return true;
      }
      return false;
    }, { timeout: 20000 }).catch(() => {});
  }

  // 分类阻断
  if (/login\.php|challenge|cloudflare/i.test(page.url())) {
    page.off('response', onResp);
    throw new Error('AUTH_OR_ANTIBOT');
  }
  if (got429) {
    page.off('response', onResp);
    throw new Error('HTTP 429 Too Many Requests');
  }
  page.off('response', onResp);

  // 若仍不可见，记快照并抛错
  const seen = await page.evaluate(() => {
    const t = document.querySelector('#dataTable');
    if (t && t.querySelectorAll('tbody tr').length > 0) return true;
    if (document.querySelector('.no-results')) return true;
    const wrap = document.querySelector('#dataTable_wrapper');
    if (wrap) {
      const tb = wrap.querySelector('table#dataTable') || wrap.querySelector('table');
      if (tb && tb.querySelectorAll('tbody tr').length > 0) return true;
    }
    return false;
  });
  if (!seen) {
    await dumpSnapshot(page, 'nav-timeout');
    throw new Error('NAV_TIMEOUT: table/empty selector did not appear');
  }

  // 抓取（兼容 wrapper）
  const items = await page.evaluate(() => {
    let table = document.querySelector('#dataTable');
    if (!table) {
      const wrap = document.querySelector('#dataTable_wrapper');
      if (wrap) table = wrap.querySelector('table#dataTable') || wrap.querySelector('table');
    }
    if (!table) return [];

    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const seenSet = new Set();
    const out = [];
    for (const row of rows) {
      const tds = row.querySelectorAll('td');
      if (tds.length < 5) continue;

      const idCard  = tds[0].innerText.trim();
      const name    = tds[1].innerText.trim();
      const oldId   = tds[2].innerText.trim();
      const address = tds[3].innerText.trim();
      const phone   = tds[4].innerText.trim();

      const finalId = idCard && idCard !== 'NULL'
        ? idCard
        : (oldId && oldId !== 'NULL' ? oldId : '');

      if (!finalId && !phone) continue;

      const key = `${finalId || 'NA'}-${phone || 'NA'}`;
      if (seenSet.has(key)) continue;
      seenSet.add(key);

      out.push({
        name: name || 'Unknown',
        idCard: finalId || '',
        phone: phone || '',
        address: address || 'Unknown'
      });
    }
    return out;
  });

  return items;
}

/* ============== 对外主函数 ============== */
async function search(queryText) {
  await acquire(); // 串行排队
  let page;
  try {
    await sleep(150 + Math.floor(Math.random() * 400)); // 抖动
    const browser = await getBrowser();
    page = await browser.newPage();

    // 统一超时
    page.setDefaultTimeout(70000);
    page.setDefaultNavigationTimeout(70000);

    // 诊断日志
    page.on('console', (m) => console.log('[PAGE_CONSOLE]', m.type(), m.text()));
    page.on('pageerror', (e) => console.error('[PAGEERROR]', e));
    page.on('error', (e) => console.error('[PAGE_CRASH]', e));
    page.on('requestfailed', (req) =>
      console.warn('[REQ_FAIL]', req.url(), req.failure()?.errorText)
    );

    await ensureCookies(page);

    const results = await withRetries(() => doSearchOnce(page, queryText), {
      retries: 3,
      baseDelay: 800
    });

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

  } catch (error) {
    console.error('An error occurred during the search:', error);
    return 'An error occurred while searching. Please try again later.';
  } finally {
    if (page) {
      try { await page.close({ runBeforeUnload: true }); } catch (_) {}
    }
    release();
  }
}

module.exports = search;
