const RateBucket = require('./models/RateBucket');
const { ratePerMinute } = require('./config');

/**
 * 简易限流：按 Telegram userId 每分钟不超过 N 次
 * 说明：极端并发下可能小幅超限（竞态），如需强一致请用 Redis + Lua 或 Mongo 事务。
 */
async function checkAndConsume(userId) {
  const now = new Date();
  const minuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const expireAt = new Date(minuteStart.getTime() + 60000);

  try {
    // upsert 桶 + 自增
    const doc = await RateBucket.findOneAndUpdate(
      { userId, minuteStart },
      { $setOnInsert: { userId, minuteStart, expireAt }, $inc: { count: 1 } },
      { new: true, upsert: true }
    );
    if (doc.count > ratePerMinute) return { allowed: false, remaining: 0 };
    return { allowed: true, remaining: Math.max(ratePerMinute - doc.count, 0) };
  } catch (e) {
    // 若唯一索引冲突，重试一次
    const doc = await RateBucket.findOneAndUpdate(
      { userId, minuteStart },
      { $inc: { count: 1 } },
      { new: true }
    );
    if (!doc) return { allowed: false, remaining: 0 };
    if (doc.count > ratePerMinute) return { allowed: false, remaining: 0 };
    return { allowed: true, remaining: Math.max(ratePerMinute - doc.count, 0) };
  }
}

module.exports = { checkAndConsume };
