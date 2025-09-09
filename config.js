require('dotenv').config();

module.exports = {
  botToken: process.env.BOT_TOKEN,
  mongodbUri: process.env.MONGODB_URI,
  port: process.env.PORT || 8080,
  sessionSecret: process.env.SESSION_SECRET || 'your-secret-key',
  renderUrl: process.env.RENDER_URL,
  botUsername: process.env.BOT_USERNAME || 'your_bot_username',
  hlrApiKey: process.env.HLR_API_KEY,
};
