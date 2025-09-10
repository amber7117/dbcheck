require('dotenv').config();

module.exports = {
  botToken: process.env.BOT_TOKEN,
  mongodbUri: process.env.MONGODB_URI,
  port: process.env.PORT || 8080,
  sessionSecret: process.env.SESSION_SECRET || '024374fe9fcc',
  renderUrl: 'https://dbcheck-pqur.onrender.com',
  botUsername: process.env.BOT_USERNAME || 'your_bot_username',
  hlr: {
    key: process.env.HLR_API_KEY,
    secret: process.env.HLR_API_SECRET,
  },
  cacheTtlMinutes: parseInt(process.env.CACHE_TTL_MINUTES || '60', 10),
  ratePerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '30', 10),
  defaultRegion: (process.env.DEFAULT_REGION || 'MY').toUpperCase(),
};






