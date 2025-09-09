require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');
const fs = require('fs');
const path = require('path');
const User = require('./models/user');
const QueryLog = require('./models/queryLog');
const search = require('./crawler/search');
const { lookup } = require('./hlrlookup');
const { assignDepositAddress, checkDeposits } = require('./services/topup');
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 8080;
const login = require('./crawler/login');


if (!BOT_TOKEN) {
  throw new Error("❌ BOT_TOKEN is missing in environment variables");
}
if (!MONGODB_URI) {
  throw new Error("❌ MONGODB_URI is missing in environment variables");
}

const bot = new Telegraf(BOT_TOKEN);

// Connect to MongoDB
mongoose.connect(MONGODB_URI, {
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

function getLocale(languageCode) {
  return locales[languageCode] || locales['en'];
}

// ========== START command ==========
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  let user = await User.findOne({ userId });

  if (!user) {
    const inviteMatch = ctx.startPayload?.match(/invite_(\d+)/);
    const invitedBy = inviteMatch ? parseInt(inviteMatch[1]) : null;

    user = new User({ userId, invitedBy, points: 0 });
    await user.save();

    if (invitedBy) {
      await User.findOneAndUpdate(
        { userId: invitedBy },
        { $inc: { points: 1 } }
      );
    }
  }

  const lang = getLocale(ctx.from.language_code);
  await ctx.replyWithMarkdown(
    lang.welcome.replace('{userId}', userId).replace('{points}', user.points),
    Markup.inlineKeyboard([
      [Markup.button.callback('💎 Premium Search', 'premium')],
      [Markup.button.callback('💳 Top Up', 'recharge'), Markup.button.callback('❓ Help', 'help')],
      [Markup.button.callback('👥 Invite', 'invite'), Markup.button.callback('☎️ Support', 'support')]
    ])
  );
});

// ========== PREMIUM SEARCH ==========
bot.action('premium', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  const lang = getLocale(ctx.from.language_code);
  if (!user) return ctx.reply(lang.not_registered);

  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    lang.premium_search_prompt.replace('{points}', user.points),
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm (50 points)', 'confirm_premium')],
      [Markup.button.callback('❌ Cancel', 'cancel_premium')]
    ])
  );
});

(async () => {
  try {
    await login();
  } catch (err) {
    console.error("❌ Failed to login at startup:", err.message);
  }
})();

bot.action('confirm_premium', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  const lang = getLocale(ctx.from.language_code);
  if (!user) return ctx.reply(lang.not_registered);

  if (user.points < 50) {
    await ctx.answerCbQuery();
    return ctx.reply(lang.insufficient_balance);
  }

  await User.updateOne({ userId }, { $inc: { points: -50 } });

  await new QueryLog({
    userId,
    query: '[Premium Search Requested]',
    results: 0,
    success: true
  }).save();

  await ctx.answerCbQuery();
  await ctx.reply(lang.premium_search_confirmed);
});

bot.action('cancel_premium', async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id;
  let user = await User.findOne({ userId });
  if (!user) {
    user = new User({ userId, points: 0 });
    await user.save();
  }
  const lang = getLocale(ctx.from.language_code);

  await ctx.replyWithMarkdown(
    lang.premium_search_cancelled.replace('{userId}', userId).replace('{points}', user.points),
    Markup.inlineKeyboard([
      [Markup.button.callback('💎 Premium Search', 'premium')],
      [Markup.button.callback('💳 Top Up', 'recharge'), Markup.button.callback('❓ Help', 'help')],
      [Markup.button.callback('👥 Invite', 'invite'), Markup.button.callback('☎️ Support', 'support')]
    ])
  );
});

// ========== BALANCE ==========
bot.command('balance', async (ctx) => {
  const user = await User.findOne({ userId: ctx.from.id });
  const lang = getLocale(ctx.from.language_code);
  if (!user) return ctx.reply(lang.not_registered);
  return ctx.reply(lang.balance_message.replace('{points}', user.points), { parse_mode: 'Markdown' });
});

// ========== LOOKUP COMMAND ==========
bot.command('lookup', async (ctx) => {
    const lang = getLocale(ctx.from.language_code);
    const phoneNumber = ctx.message.text.split(' ')[1];

    if (!phoneNumber) {
        return ctx.reply(lang.lookup_prompt);
    }

    const result = await lookup(phoneNumber);

    if (result) {
        ctx.reply(`${lang.lookup_result}\n\n<pre>${JSON.stringify(result, null, 2)}</pre>`, { parse_mode: 'HTML' });
    } else {
        ctx.reply(lang.hlr_error);
    }
});

// ========== QUERY ==========
bot.command('query', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  const lang = getLocale(ctx.from.language_code);
  if (!user || user.points <= 0) {
    await new QueryLog({ userId, query: ctx.message.text, results: 0, success: false }).save();
    return ctx.reply(lang.no_points);
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) return ctx.reply(lang.query_prompt);

  const queryText = args.join(' ');
  const waitMsg = await ctx.reply(lang.searching);

  try {
    const results = await search(queryText);
    await ctx.deleteMessage(waitMsg.message_id);

    if (!results.length) {
      await new QueryLog({ userId, query: queryText, results: 0, success: false }).save();
      return ctx.reply(lang.no_results);
    }

    await User.updateOne({ userId }, { $inc: { points: -1 } });
    await new QueryLog({ userId, query: queryText, results: results.length, success: true }).save();

    const formatted = results.map(r => 
`Name: ${r.name}
ID Card: ${r.idCard}
Phone: ${r.phone}
Address: ${r.address}
-------------------`).join('\n');

    await ctx.reply(lang.results_found.replace('{count}', results.length).replace('{results}', formatted), { parse_mode: 'Markdown' });

  } catch (e) {
    console.error(e);
    await new QueryLog({ userId, query: queryText, results: 0, success: false }).save();
    await ctx.reply(lang.search_error);
  }
});

// ========== HANDLE QUICK QUERY ==========
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  ctx.message.text = `/query ${ctx.message.text}`;
  return bot.handleUpdate(ctx.update);
});

// ========== OTHER CALLBACKS ==========
bot.action('recharge', async (ctx) => {
    await ctx.answerCbQuery();
    const lang = getLocale(ctx.from.language_code);
    await ctx.reply(lang.payment_prompt, {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '100 Stars', callback_data: 'stars_100' },
                    { text: '500 Stars', callback_data: 'stars_500' },
                    { text: '1000 Stars', callback_data: 'stars_1000' },
                ],
            ],
        },
    });
});

bot.action(/stars_(\d+)/, async (ctx) => {
    const amount = parseInt(ctx.match[1]);
    const lang = getLocale(ctx.from.language_code);

    // Here you would integrate with Telegram's payment API
    // For now, we'll just simulate a successful payment
    const userId = ctx.from.id;
    await User.findOneAndUpdate({ userId }, { $inc: { points: amount } });

    await ctx.answerCbQuery();
    await ctx.reply(lang.payment_successful);
});

// 定时任务检测充值
setInterval(() => checkDeposits(bot), 30000);

bot.action('help', async (ctx) => {
  const user = await User.findOne({ userId: ctx.from.id });
  const lang = getLocale(ctx.from.language_code);
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(lang.help_message.replace('{points}', user?.points || 0));
});

bot.action('invite', async (ctx) => {
  await ctx.answerCbQuery();
  const inviteLink = `https://t.me/${ctx.botInfo.username}?start=invite_${ctx.from.id}`;
  const lang = getLocale(ctx.from.language_code);
  await ctx.reply(lang.invite_message.replace('{inviteLink}', inviteLink));
});

bot.action('support', async (ctx) => {
  await ctx.answerCbQuery();
  const lang = getLocale(ctx.from.language_code);
  await ctx.reply(lang.support_message);
});

// ========== ERROR HANDLING ==========
bot.catch((err, ctx) => {
  console.error(`❌ Error at update ${ctx.updateType}:`, err);
});

// ========== EXPRESS SERVER FOR CLOUD RUN ==========
const app = express();
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.get("/", (req, res) => res.send("🤖 Bot is running on Cloud Run!"));

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 Set Telegram webhook to: https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=https://dbcheck-pqur.onrender.com/${WEBHOOK_PATH}`);
});
