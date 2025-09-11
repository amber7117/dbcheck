require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');
const admin = require('./admin');

const User = require('./models/user');
const QueryLog = require('./models/queryLog');
const search = require('./crawler/search');

console.log("Mongo URI:", process.env.MONGODB_URI);

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 8080;

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

// Admin check function
async function checkAdmin(ctx) {
  const isAdminUser = await admin.isAdmin(ctx.from.id);
  if (!isAdminUser) {
    await ctx.reply('❌ You are not authorized to use this command.');
    return false;
  }
  return true;
}

// ====== ADMIN COMMANDS ======
bot.command('adminhelp', async (ctx) => {
  if (!await checkAdmin(ctx)) return;
  
  const helpText = `
🤖 <b>Admin Commands</b>

<code>/adminhelp</code> - Show this help message
<code>/setadmin <userId></code> - Make a user an admin
<code>/userinfo <userId></code> - Get user information
<code>/addpoints <userId> <points></code> - Add points to a user
<code>/userhistory <userId></code> - Get user search history
<code>/listusers</code> - List all users

🌐 <b>Web Admin Panel</b>
Visit: /admin.html
  `;
  
  await ctx.reply(helpText, { parse_mode: 'HTML' });
});

bot.command('setadmin', async (ctx) => {
  if (!await checkAdmin(ctx)) return;
  
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) return ctx.reply('Usage: /setadmin <userId>');
  
  const userId = parseInt(args[0]);
  if (isNaN(userId)) return ctx.reply('Invalid user ID');
  
  try {
    await admin.setAdmin(userId, true);
    await ctx.reply(`✅ User ${userId} is now an admin`);
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

bot.command('userinfo', async (ctx) => {
  if (!await checkAdmin(ctx)) return;
  
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) return ctx.reply('Usage: /userinfo <userId>');
  
  const userId = parseInt(args[0]);
  if (isNaN(userId)) return ctx.reply('Invalid user ID');
  
  try {
    const userInfo = await admin.getUserInfo(userId);
    await ctx.reply(`📋 User Info:\n<pre>${JSON.stringify(userInfo, null, 2)}</pre>`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

bot.command('addpoints', async (ctx) => {
  if (!await checkAdmin(ctx)) return;
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) return ctx.reply('Usage: /addpoints <userId> <points>');
  
  const userId = parseInt(args[0]);
  const points = parseInt(args[1]);
  
  if (isNaN(userId) || isNaN(points)) return ctx.reply('Invalid user ID or points');
  
  try {
    await admin.addPoints(userId, points);
    await ctx.reply(`✅ Added ${points} points to user ${userId}`);
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

bot.command('userhistory', async (ctx) => {
  if (!await checkAdmin(ctx)) return;
  
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) return ctx.reply('Usage: /userhistory <userId>');
  
  const userId = parseInt(args[0]);
  if (isNaN(userId)) return ctx.reply('Invalid user ID');
  
  try {
    const history = await admin.getUserHistory(userId);
    if (history.length === 0) {
      await ctx.reply('No search history found for this user');
      return;
    }
    
    let historyText = `📊 Search History for User ${userId}:\n\n`;
    history.forEach((log, index) => {
      historyText += `${index + 1}. ${log.query} - ${log.success ? '✅' : '❌'} - ${new Date(log.createdAt).toLocaleString()}\n`;
    });
    
    await ctx.reply(historyText);
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

bot.command('listusers', async (ctx) => {
  if (!await checkAdmin(ctx)) return;
  
  try {
    const users = await admin.listUsers();
    if (users.length === 0) {
      await ctx.reply('No users found');
      return;
    }
    
    let usersText = '👥 Users List:\n\n';
    users.forEach((user, index) => {
      usersText += `${index + 1}. ID: ${user.userId}, Points: ${user.points}, Admin: ${user.isAdmin ? '✅' : '❌'}\n`;
    });
    
    await ctx.reply(usersText);
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// ====== BASIC BOT FUNCTIONALITY ======
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  let user = await User.findOne({ userId });
  if (!user) {
    user = new User({ userId });
    await user.save();
  }
  await ctx.reply(`欢迎，您的积分：${user.points}`);
});

bot.command('query', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  if (!user || user.points <= 0) return ctx.reply('积分不足');

  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) return ctx.reply('请输入查询参数');

  const queryText = args.join(' ');
  const waitMsg = await ctx.reply('正在查询...');

  try {
    const results = await search(queryText);
    await ctx.deleteMessage(waitMsg.message_id);

    await new QueryLog({ userId, query: queryText, results: results.length, success: true }).save();

    if (!results.length) return ctx.reply('未找到结果');

    // Deduct points only if results found
    await User.updateOne({ userId }, { $inc: { points: -1 } });

    const formatted = results.map(r => `
姓名: ${r.name}
身份证: ${r.idCard}
手机号: ${r.phone}
地址: ${r.address}
-------------------`).join('\n');

    await ctx.reply(`找到 ${results.length} 条结果:\n${formatted}`);
  } catch (e) {
    console.error(e);
    await ctx.reply('查询失败，请稍后再试');
  }
});

// ====== EXPRESS SETUP FOR WEB ADMIN ======
app.get("/admin", (req, res) => {
  res.send("Admin panel is available at /admin.html");
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// Start the bot
bot.launch();
