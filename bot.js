require('dotenv').config();
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const routes = require('./routes');
const botHandlers = require('./bot_handlers');
const { checkDeposits } = require('./services/topup');
const login = require('./crawler/login');
const config = require('./config');

if (!config.botToken) {
  throw new Error("❌ BOT_TOKEN is missing in environment variables");
}
if (!config.mongodbUri) {
  throw new Error("❌ MONGODB_URI is missing in environment variables");
}

const bot = new Telegraf(config.botToken);
const app = express();

// Connect to MongoDB
mongoose.connect(config.mongodbUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// i18n setup
const locales = {};
const localesDir = path.join(__dirname, 'locales');
fs.readdirSync(localesDir).forEach(file => {
  if (file.endsWith('.json')) {
    const lang = file.split('.')[0];
    locales[lang] = require(path.join(localesDir, file));
  }
});

// Register bot handlers
botHandlers.register(bot, locales);

// Express setup
app.use(express.json());
app.use(express.static('public'));
app.use(cookieParser());
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: config.renderUrl ? true : false },
}));

// Security middleware
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Register routes
app.use('/', routes);

// Set up webhook
const WEBHOOK_PATH = `/webhook/${config.botToken}`;
app.use(bot.webhookCallback(WEBHOOK_PATH));

// Error handling
bot.catch((err, ctx) => {
  console.error(`❌ Error at update ${ctx.updateType}:`, err);
});

// Start crawler login
(async () => {
  try {
    await login();
  } catch (err) {
    console.error("❌ Failed to login at startup:", err.message);
  }
})();

// Start deposit check interval
setInterval(() => checkDeposits(bot), 30000);

// Start server
app.listen(config.port, () => {
  console.log(`✅ Server running on port ${config.port}`);
  if (config.renderUrl) {
    console.log(`🚀 Web UI available at: ${config.renderUrl}`);
  } else {
    console.log(`🚀 Web UI available at: http://localhost:${config.port}`);
  }
});
