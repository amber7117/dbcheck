// search.js
// 说明：稳定版爬虫入口 —— 队列串行 + 浏览器单例 + 提交/等待三路并行 + 退避重试 + Cookie自愈

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const Cookie = require('../models/cookie');
const login = require('./login');

puppeteer.use(StealthPlugin());

/** ======================== 小工具 ======================== **/
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const LANG_HDR = { 'Accept-Language': 'en-US,en;q=0.9' };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** ================== 全局并发控制（必须排队） ================== **/
const MAX_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.CRAWLER_CONCURRENCY || '1', 10)
);
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

/** =================== 浏览器单例（复用） =================== **/
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

/** ======================= 重试封装 ======================= **/
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

/** ==================== Cookie 会话自愈 ==================== **/
async function ensureCookies(page) {
  // 更像真人浏览器（对风控/渲染友好）
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders(LANG_HDR);
  try { await page.emulateTimezone('Asia/Kuala_Lumpur'); } catch (_) {}

  let dbCookies = await Cookie.findOne({ name: 'zowner' });
  if (!dbCookies) {
    console.log('⚠️ No cookies found, logging in...');
    await login();
    dbCookies = await Cookie.findOne({ name: 'zowner' });
  }

  // 先到同域，降低 sameSite=Lax 影响
  await page.goto('https://zowner.info/index.php', { waitUntil: 'domcontentloaded' });

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

  // 校验会话
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
    await page.goto('https://zowner.info/index.php', { waitUntil: 'networkidle2' });
  }
}

/** ============ 提交并稳健等待：导航/DOM/URL 三路并行 ============ **/
async function submitAndRobustWait(page) {
  // 并行等待三种可能：导航完成 / 表格出现（AJAX 渲染）/ URL 被拦截到登录/挑战
  await Promise.race([
    // 路径1：确实发生了导航
    (async () => {
      await Promise.allSettled([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
        page.click('input[type="submit"]')
      ]);
    })(),

    // 路径2：未导航，但表格通过 AJAX 渲染
    (async () => {
      await page.click('input[type="submit"]');
      await page.waitForFunction(() => {
        // 结果条件1：原始表格有行
        const t = document.querySelector('#dataTable');
        if (t && t.querySelectorAll('tbody tr').length > 0) return true;
        // 结果条件2：空结果
        if (document.querySelector('.no-results')) return true;
        // 结果条件3：DataTables 包裹后也可能是 #dataTable_wrapper
        const wrap = document.querySelector('#dataTable_wrapper');
        if (wrap) {
          const tb = wrap.querySelector('table#dataTable') || wrap.querySelector('table');
          if (tb && tb.querySelectorAll('tbody tr').length > 0) return true;
        }
        return false;
      }, { timeout: 60000 });
    })(),

    // 路径3：跳转到了登录/挑战/风控
    (async () => {
      await page.click('input[type="submit"]');
      await page.waitForFunction(
        () => /login\.php|challenge|cloudflare/i.test(location.href),
        { timeout: 60000 }
      );
    })()
  ]);
}

/** ======================== 单次查询 ======================== **/
async function doSearchOnce(page, queryText) {
  // 选择类目：12位纯数字→身份证；其他纯数字→电话；否则名字
  let category = 3;
  if (/^\d+$/.test(queryText)) category = queryText.length === 12 ? 1 : 4;

  // 到搜索页
  await page.goto('https://zowner.info/index.php', { waitUntil: 'domcontentloaded' });

  // 确保表单存在
  await page.waitForSelector('input[name="keyword"]', { timeout: 20000 });
  await page.waitForSelector('select[name="category"]', { timeout: 20000 });

  // 填表
  await page.$eval('input[name="keyword"]', (el) => (el.value = ''));
  await page.type('input[name="keyword"]', queryText, { delay: 8 });
  await page.select('select[name="category"]', String(category));

  // 监测 429
  let got429 = false;
  const onResp = (resp) => { if (resp.status() === 429) got429 = true; };
  page.on('response', onResp);

  // 提交并稳健等待
  try {
    await submitAndRobustWait(page);
  } catch (e) {
    console.warn('⚠️ submitAndRobustWait failed once, try soft reload...', e.message);
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(500);
    // 再做一次短轮询
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

  // 若仍看不见结果或空态，判定为导航/渲染超时
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
  if (!seen) throw new Error('NAV_TIMEOUT: table/empty selector did not appear');

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

/** ======================== 对外主函数 ======================== **/
async function search(queryText) {
  await acquire(); // ✅ 所有请求必须排队，防止并发打爆
  let page;
  try {
    // 轻度抖动，避免“齐步走”引发站点限流
    await sleep(150 + Math.floor(Math.random() * 400));

    const browser = await getBrowser();
    page = await browser.newPage();

    // 黑匣子日志，方便定位问题
    page.on('console', (m) => console.log('[PAGE_CONSOLE]', m.type(), m.text()));
    page.on('pageerror', (e) => console.error('[PAGEERROR]', e));
    page.on('error', (e) => console.error('[PAGE_CRASH]', e));
    page.on('requestfailed', (req) =>
      console.warn('[REQ_FAIL]', req.url(), req.failure()?.errorText)
    );

    await ensureCookies(page);

    // 退避重试：处理 429 / 风控 / 渲染偶发卡死
    const results = await withRetries(() => doSearchOnce(page, queryText), {
      retries: 3,
      baseDelay: 800
    });

    return results;
  } finally {
    if (page) {
      try { await page.close({ runBeforeUnload: true }); } catch (_) {}
    }
    release(); // ✅ 释放队列
  }
}

module.exports = search;
