// hlrClient.js
require('dotenv').config();
const HlrLookupClient = require('node-hlr-client');

// 用官方 SDK 构造客户端（README 用法）:
const client = new HlrLookupClient(
  process.env.HLR_API_KEY,
  process.env.HLR_API_SECRET
);

// 简洁封装常用接口
async function auth() {
  // GET /auth-test：验证凭据是否可用（200 表示成功）
  // 官方 README 示例使用 .get('/auth-test')
  return client.get('/auth');
}

async function hlrLookup(msisdn, options = {}) {
  // POST /hlr-lookup：实时查询 HLR（README 示例）
  // options 可传 route/storage 等可选字段
  return client.post('/hlr-lookup', { msisdn, ...options });
}

async function ntLookup(number, options = {}) {
  // POST /nt-lookup：Number Type（座机/手机号/是否可做 HLR 等）
  return client.post('/nt-lookup', { number, ...options });
}

async function mnpLookup(msisdn, options = {}) {
  // POST /mnp-lookup：携号转网（是否 ported、原/现网等）
  return client.post('/mnp-lookup', { msisdn, ...options });
}

module.exports = {
  auth,
  hlrLookup,
  ntLookup,
  mnpLookup,
};