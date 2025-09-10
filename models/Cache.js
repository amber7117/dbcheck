const mongoose = require('mongoose');
const { cacheTtlMinutes } = require('../config');

const CacheSchema = new mongoose.Schema({
  key: { type: String, unique: true, index: true }, // e.g. "hlr:+60123456789"
  data: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, index: true }
});

// TTL 索引：createdAt 超过 N 分钟自动过期删除
CacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: cacheTtlMinutes * 60 });

module.exports = mongoose.model('Cache', CacheSchema);
