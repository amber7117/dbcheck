const mongoose = require('mongoose');

// 桶维度：userId + minuteStart
const RateBucketSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  minuteStart: { type: Date, index: true },
  count: { type: Number, default: 0 },
  expireAt: { type: Date, index: true } // TTL
});

// TTL：一分钟后清桶
RateBucketSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
// 组合唯一，避免同分钟重复建桶
RateBucketSchema.index({ userId: 1, minuteStart: 1 }, { unique: true });

module.exports = mongoose.model('RateBucket', RateBucketSchema);
