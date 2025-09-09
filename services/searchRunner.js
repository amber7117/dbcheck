const search = require('../crawler/search');

function classifyError(err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (/429|Too Many Requests/i.test(msg)) return { code: 'RATE_LIMIT', hint: '被目标站限流' };
  if (/Navigation timeout|waitForSelector|Execution context|Timeout/i.test(msg)) return { code: 'NAV_TIMEOUT', hint: '页面/选择器等待超时' };
  if (/net::ERR_|ECONN|ENOTFOUND|TLS|socket|timeout/i.test(msg)) return { code: 'NETWORK', hint: '网络或证书问题' };
  if (/executablePath|launch|No usable sandbox|HeadlessShell/i.test(msg)) return { code: 'LAUNCH', hint: '浏览器启动问题' };
  if (/login|Cookies expired|AUTH_OR_ANTIBOT/i.test(msg)) return { code: 'AUTH', hint: '会话过期或风控拦截' };
  return { code: 'UNKNOWN', hint: '未知错误' };
}

async function withRetries(fn, { retries = 3, baseDelay = 800 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt > retries) throw e;
      const jitter = Math.floor(Math.random() * 400);
      const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
      console.warn(`⚠️ attempt ${attempt} failed: ${e.message || e}. retry in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function runSearchSafe(query) {
  const t0 = Date.now();
  try {
    const data = await withRetries(() => search(query));
    return { ok: true, data, ms: Date.now() - t0 };
  } catch (err) {
    const { code, hint } = classifyError(err);
    return {
      ok: false,
      code, hint,
      message: err && err.stack ? err.stack : String(err),
      ms: Date.now() - t0
    };
  }
}

module.exports = { runSearchSafe };
