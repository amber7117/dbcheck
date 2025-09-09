require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');
const User = require('./models/user');
const QueryLog = require('./models/queryLog');
const search = require('./crawler/search');
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

  await ctx.replyWithMarkdown(
`👋 

🆔 Your ID: \`${userId}\`  
💰 Current Balance: *${user.points} points*

🔎 Quick Query:  
Send *name / phone number / ID card number*  

📑 Combined Query:  
Use */query* command with multiple parameters  
/query Ahmad Faizal  
/query 0164441111
/query 90010111XXXX  

⚠️ This bot only displays 4 fields:  
*Name, ID Card, Phone, Address*
*For other go to premium search*  
`,
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
  if (!user) return ctx.reply('❌ You are not registered yet. Use /start first.');

  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
`💎 *Premium Search Service*

Available:  
- 🏠 Address Search  
- 📍 Phone Geo-location  
- 🚗 License Plate Search  
- … and more

⚠️ Each premium search costs *50 points*.  
💰 Your balance: *${user.points} points*

Do you want to proceed?`,
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
  if (!user) return ctx.reply('❌ You are not registered yet. Use /start first.');

  if (user.points < 50) {
    await ctx.answerCbQuery();
    return ctx.reply('❌ Insufficient balance. Please contact @dbcheck to recharge.');
  }

  await User.updateOne({ userId }, { $inc: { points: -50 } });

  await new QueryLog({
    userId,
    query: '[Premium Search Requested]',
    results: 0,
    success: true
  }).save();

  await ctx.answerCbQuery();
  await ctx.reply('✅ 50 points deducted. Please provide your premium search details to @dbcheck.');
});

bot.action('cancel_premium', async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id;
  let user = await User.findOne({ userId });
  if (!user) {
    user = new User({ userId, points: 0 });
    await user.save();
  }

  await ctx.replyWithMarkdown(
`👋 Welcome back

🆔 Your ID: \`${userId}\`  
💰 Current Balance: *${user.points} points*

🔎 Quick Query:  
Send *name / phone number / ID card number*  

📑 Combined Query:  
Use */query* command with multiple parameters  
/query Wang Weilin  
/query 110101198906046034 xxLin  
/query Zhang San 1373xxxxx55  

⚠️ This bot only displays 4 fields:  
*Name, ID Card, Phone, Address*  
`,
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
  if (!user) return ctx.reply('❌ You are not registered yet. Use /start first.');
  return ctx.reply(`💰 Your current balance: *${user.points} points*`, { parse_mode: 'Markdown' });
});

// ========== QUERY ==========
bot.command('query', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  if (!user || user.points <= 0) {
    await new QueryLog({ userId, query: ctx.message.text, results: 0, success: false }).save();
    return ctx.reply('❌ You don’t have enough points. Please recharge.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) return ctx.reply('Please provide a search query, e.g. `/query John Smith`');

  const queryText = args.join(' ');
  const waitMsg = await ctx.reply('🔍 Searching, please wait...');

  try {
    const results = await search(queryText);
    await ctx.deleteMessage(waitMsg.message_id);

    if (!results.length) {
      await new QueryLog({ userId, query: queryText, results: 0, success: false }).save();
      return ctx.reply('⚠️ No matching results found. No points deducted.');
    }

    await User.updateOne({ userId }, { $inc: { points: -1 } });
    await new QueryLog({ userId, query: queryText, results: results.length, success: true }).save();

    const formatted = results.map(r => 
`Name: ${r.name}
ID Card: ${r.idCard}
Phone: ${r.phone}
Address: ${r.address}
-------------------`).join('\n');

    await ctx.reply(`✅ Found *${results.length}* results:\n\n${formatted}`, { parse_mode: 'Markdown' });

  } catch (e) {
    console.error(e);
    await new QueryLog({ userId, query: queryText, results: 0, success: false }).save();
    await ctx.reply('❌ Error occurred while searching. Please try again later.');
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
  const userId = ctx.from.id;
  let user = await User.findOne({ userId });

  if (!user) {
    user = new User({ userId, points: 0 });
    await user.save();
  }

  const addr = await assignDepositAddress(user);

  await ctx.replyWithMarkdown(
`💳 *USDT-TRC20 Recharge*

Send at least *100 USDT* to:

\`${addr}\`

1 USDT = 1 point  
⚠️ Minimum deposit = 100 USDT

Your balance will update automatically after confirmation.`
  );
});

// 定时任务检测充值
setInterval(() => checkDeposits(bot), 30000);

bot.action('help', async (ctx) => {
  const user = await User.findOne({ userId: ctx.from.id });
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
`💰 Balance: ${user?.points || 0}

📖 How to Use:
1️⃣ Quick Query: Send a name, ID, or phone directly  
2️⃣ Combined Query: Use /query with multiple params  
3️⃣ Each successful query deducts *1 point*  
4️⃣ No deduction if no results  
5️⃣ Invite friends to earn free points  
6️⃣ Premium searches cost *50 points* (contact @dbcheck)`);
});

bot.action('invite', async (ctx) => {
  await ctx.answerCbQuery();
  const inviteLink = `https://t.me/${ctx.botInfo.username}?start=invite_${ctx.from.id}`;
  await ctx.reply(`👥 Invite friends to use this bot. You’ll earn *1 point* per signup.\n\nYour referral link:\n${inviteLink}`);
});

bot.action('support', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('☎️ Contact support:@ dbchect');
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
  console.log(`📡 Set Telegram webhook to: https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=https://dbcheck-bot-549712884410.asia-southeast1.run.app${WEBHOOK_PATH}`);
});

