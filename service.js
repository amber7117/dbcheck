const Cache = require('./models/Cache');
const { getClient } = require('./hlrClient');
const logger = require('./logger');

// 并发去重：相同 key 时只打一次下游
const inflight = new Map();
function dedupe(key, producer) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      return await producer();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function cachedCall(key, fetcher) {
  // 1) 查缓存
  const hit = await Cache.findOne({ key }).lean();
  if (hit) return { cache: true, data: hit.data };

  // 2) 去重 + 下游
  const result = await dedupe(key, async () => {
    const data = await fetcher();
    // 异步存缓存（不阻塞）
    Cache.updateOne({ key }, { $set: { key, data, createdAt: new Date() } }, { upsert: true }).catch(e => {
      logger.warn({ err: e }, 'cache upsert failed');
    });
    return data;
  });

  return { cache: false, data: result };
}

async function hlrLookupE164(e164) {
  const client = getClient();
  const key = `hlr:${e164}`;
  return cachedCall(key, async () => {
    const r = await client.post('/hlr-lookup', { msisdn: e164 });
    return r.data;
  });
}

async function ntLookupE164(e164) {
  const client = getClient();
  const key = `nt:${e164}`;
  return cachedCall(key, async () => {
    const r = await client.post('/nt-lookup', { number: e164 });
    return r.data;
  });
}

async function mnpLookupE164(e164) {
  const client = getClient();
  const key = `mnp:${e164}`;
  return cachedCall(key, async () => {
    const r = await client.post('/mnp-lookup', { msisdn: e164 });
    return r.data;
  });
}

module.exports = { hlrLookupE164, ntLookupE164, mnpLookupE164 };
