const WINDOW_MS = parseInt(process.env.DEDUP_WINDOW_MS || '60000', 10);
const inflight = new Map(); // key -> Promise
const lastAt = new Map();   // key -> timestamp

function keyOf(userId, query) {
  return `${userId}::${query}`;
}

/**
 * 相同用户+相同查询 60s 内只跑一个；后到的复用同一 Promise 结果。
 */
function dedupRun(userId, query, execFn) {
  const key = keyOf(userId, query);
  const now = Date.now();

  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const p = execFn()
    .finally(() => {
      lastAt.set(key, Date.now());
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}

module.exports = { dedupRun, keyOf, WINDOW_MS };
