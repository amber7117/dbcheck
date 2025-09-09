
let windowStart = Date.now();
let total = 0;
let rateLimitHits = 0;

function record(ok, code) {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    total = 0;
    rateLimitHits = 0;
  }
  total++;
  if (!ok && code === 'RATE_LIMIT') rateLimitHits++;
}

/** 当最近1分钟 429 占比>40%且样本>=10时打开熔断 */
function isOpen() {
  if (total < 10) return false;
  return (rateLimitHits / total) > 0.4;
}

module.exports = { record, isOpen };
