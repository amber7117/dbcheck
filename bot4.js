require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const User = require('./models/user');
const QueryLog = require('./models/queryLog');
const search = require('./crawler/search');
const express = require('express');
const app = express();

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;

const bot = new Telegraf(BOT_TOKEN);

// Connect to MongoDB
mongoose.connect(MONGODB_URI, { 
  useNewUrlParser: true, 
  useUnifiedTopology: true 
});

// START command
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  let user = await User.findOne({ userId });

  if (!user) {
    // Check referral
    const inviteMatch = ctx.startPayload?.match(/invite_(\d+)/);
    const invitedBy = inviteMatch ? parseInt(inviteMatch[1]) : null;

    user = new User({ userId, invitedBy, points: 0 }); // default balance = 0
    await user.save();

    // Referral bonus
    if (invitedBy) {
      await User.findOneAndUpdate(
        { userId: invitedBy },
        { $inc: { points: 1 } }
      );
    }
  }

  await ctx.replyWithMarkdown(
`👋 Welcome

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


// Premium Search
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
- … and more advanced lookups

⚠️ Each premium search costs *50 points*.  
💰 Your balance: *${user.points} points*

Do you want to proceed?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm (50 points)', 'confirm_premium')],
      [Markup.button.callback('❌ Cancel', 'cancel_premium')]
    ])
  );
});

bot.action('confirm_premium', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });

  if (!user) return ctx.reply('❌ You are not registered yet. Use /start first.');

  if (user.points < 50) {
    await ctx.answerCbQuery();
    return ctx.reply('❌ Insufficient balance. Please topup first.');
  }

  await User.updateOne({ userId }, { $inc: { points: -50 } });

  // Save premium search record
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

// BALANCE command
bot.command('balance', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  if (!user) return ctx.reply('❌ You are not registered yet. Use /start first.');

  return ctx.reply(`💰 Your current balance: *${user.points} points*`, { parse_mode: 'Markdown' });
});


// QUERY command
bot.command('query', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });

  if (!user || user.points <= 0) {
    // Log attempt
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

    // Deduct 1 point
    await User.updateOne({ userId }, { $inc: { points: -1 } });

    // Save success log
    await new QueryLog({ userId, query: queryText, results: results.length, success: true }).save();

    const formatted = results.map(r => 
`Name: ${r.name}
ID Card: ${r.idCard}
Phone: ${r.phone}
Address: ${r.address}
-------------------`
    ).join('\n');

    await ctx.reply(`✅ Found *${results.length}* results:\n\n${formatted}`, { parse_mode: 'Markdown' });

  } catch (e) {
    console.error(e);

    await new QueryLog({ userId, query: queryText, results: 0, success: false }).save();
    await ctx.reply('❌ Error occurred while searching. Please try again later.');
  }
});


// Handle plain text as quick query
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  ctx.message.text = `/query ${ctx.message.text}`;
  return bot.handleUpdate(ctx.update);
});


// Recharge callback
bot.action('recharge', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('💳 Please contact admin @YourAdmin to recharge your points.');
});

// Help callback
bot.action('help', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });

  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
`💰 Balance: ${user?.points || 0}

📖 How to Use:

1️⃣ Quick Query: Send a name, ID, or phone directly  
2️⃣ Combined Query: Use /query with multiple params  
3️⃣ Each successful query deducts *1 point*  
4️⃣ No deduction if no results  
5️⃣ Invite friends to earn free points  
6️⃣ Premium searches cost *50 points* (contact @dbcheck)

`);
});

// Referral callback
bot.action('invite', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const inviteLink = `https://t.me/${ctx.botInfo.username}?start=invite_${userId}`;
  await ctx.reply(`👥 Invite friends to use this bot. You’ll earn *1 point* for each signup.\n\nYour referral link:\n${inviteLink}`);
});

// Support callback
bot.action('support', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('☎️ Contact support: @WikiLieMoSupport');
});


// Error handling
bot.catch((err, ctx) => {
  console.error(`❌ Error at update ${ctx.updateType}:`, err);
});


app.use(bot.webhookCallback(`/secret-path`)); // your secret path

app.get("/", (req, res) => res.send("Bot is running!"));

// Cloud Run assigns dynamic port
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// Register webhook with Telegram API once
const axios = require('axios');
(async () => {
  await axios.get(
    `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${process.env.CLOUD_RUN_URL}/secret-path`
  );
})();

// Start bot
//bot.launch().then(() => {
//  console.log('🤖 Bot started successfully');
//});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

