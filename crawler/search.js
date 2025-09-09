// search.js（替换你当前文件）
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const Cookie = require('../models/cookie');
const login = require('./login');

puppeteer.use(StealthPlugin());

/** ================= 全局并发控制（保证“必须排队”） ================= **/
const MAX_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.CRAWLER_CONCURRENCY || '1', 10)
);
let active = 0;
const waitQueue = [];
async function acquire() {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise((resolve) => waitQueue.push(resolve));
  active++;
}
function release() {
  active = Math.max(0, active - 1);
  const next = waitQueue.shift();
  if (next) next();
}

/** ================== 浏览器单例（避免频繁 launch） ================== **/
let BROWSER_PROMISE = null;
async function getBrowser() {
  if (!BROWSER_PROMISE) {
    BROWSER_PROMISE = puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
  }
  return BROWSER_PROMISE;
}

/** ======================= 工具函数：重试 ======================= **/
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
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** ======================= 会话与 Cookie 自愈 ======================= **/
async function ensureCookies(page) {
  let dbCookies = await Cookie.findOne({ name: 'zowner' });
  if (!dbCookies) {
    console.log('⚠️ No cookies found, logging in...');
    await login();
    dbCookies = await Cookie.findOne({ name: 'zowner' });
  }

  // 先到同域，降低 sameSite/Lax 影响
  await page.goto('https://zowner.info/index.php', { waitUntil: 'domcontentloaded' });

  const validCookies = dbCookies.cookies.map((c) => ({
    name: c.name || c.key,
    value: c.value,
    domain: c.domain || 'zowner.info',
    path: c.path || '/',
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: c.sameSite || 'Lax',
  }));
  await page.setCookie(...validCookies);

  // 立即校验
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
    page.reload({ waitUntil: 'networkidle2' }),
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
      sameSite: c.sameSite || 'Lax',
    }));
    await page.setCookie(...freshCookies);
    await page.goto('https://zowner.info/index.php', { waitUntil: 'networkidle2' });
  }
}

/** ======================= 单次查询（可重试） ======================= **/
async function doSearchOnce(page, queryText) {
  // 类目：12位纯数字→身份证；其他纯数字→电话；否则按姓名
  let category = 3;
  if (/^\d+$/.test(queryText)) category = queryText.length === 12 ? 1 : 4;

  // 到搜索页
  await page.goto('https://zowner.info/index.php', { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('input[name="keyword"]', { timeout: 15000 });
  await page.waitForSelector('select[name="category"]', { timeout: 15000 });

  // 填表并提交
  await page.$eval('input[name="keyword"]', (el) => (el.value = ''));
  await page.type('input[name="keyword"]', queryText, { delay: 10 });
  await page.select('select[name="category"]', String(category));

  let got429 = false;
  const onResp = (resp) => {
    if (resp.status() === 429) got429 = true;
  };
  page.on('response', onResp);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
    page.click('input[type="submit"]'),
  ]);

  // 等待结果/无结果/或风控/登录页
  await Promise.race([
    page.waitForSelector('#dataTable tbody tr', { timeout: 60000 }),
    page.waitForSelector('.no-results', { timeout: 60000 }),
    page.waitForFunction(() => /login\.php|challenge|cloudflare/i.test(location.href), {
      timeout: 60000,
    }),
  ]);

  if (/login\.php|challenge|cloudflare/i.test(page.url())) {
    page.off('response', onResp);
    throw new Error('AUTH_OR_ANTIBOT');
  }
  if (got429) {
    page.off('response', onResp);
    throw new Error('HTTP 429 Too Many Requests');
  }
  page.off('response', onResp);

  // 抓取结果
  const items = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#dataTable tbody tr'));
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const tds = row.querySelectorAll('td');
      if (tds.length >= 5) {
        const idCard = tds[0].innerText.trim();
        const name = tds[1].innerText.trim();
        const oldId = tds[2].innerText.trim();
        const address = tds[3].innerText.trim();
        const phone = tds[4].innerText.trim();

        const finalId =
          idCard && idCard !== 'NULL'
            ? idCard
            : oldId && oldId !== 'NULL'
            ? oldId
            : '';

        if (!finalId || !phone) continue;

        const key = `${finalId}-${phone}`;
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          name: name || 'Unknown',
          idCard: finalId,
          phone: phone,
          address: address || 'Unknown',
        });
      }
    }
    return out;
  });

  return items;
}

/** ======================= 对外主函数（排队+复用+重试） ======================= **/
async function search(queryText) {
  await acquire(); // ✅ 全部请求必须排队，保证不会“并发打爆”
  let page;
  try {
    // 抖动，避免“齐步走”
    await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 400)));

    const browser = await getBrowser();
    page = await browser.newPage();

    // 黑匣子事件（可留用，便于定位问题）
    page.on('console', (m) => console.log('[PAGE_CONSOLE]', m.type(), m.text()));
    page.on('pageerror', (e) => console.error('[PAGEERROR]', e));
    page.on('error', (e) => console.error('[PAGE_CRASH]', e));
    page.on('requestfailed', (req) =>
      console.warn('[REQ_FAIL]', req.url(), req.failure()?.errorText)
    );

    await ensureCookies(page);

    // 退避重试：处理 429/超时/瞬时网络波动
    const results = await withRetries(() => doSearchOnce(page, queryText), {
      retries: 3, // 可按需调大/调小
      baseDelay: 800,
    });

    return results;
  } finally {
    // 只关 Page，不关 Browser（单例复用）
    if (page) {
      try {
        await page.close({ runBeforeUnload: true });
      } catch (_) {}
    }
    release(); // ✅ 释放队列
  }
}

module.exports = search;
