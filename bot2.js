require('dotenv').config();   // 加在最顶部
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const User = require('./models/user');
const QueryLog = require('./models/queryLog');
const search = require('./crawler/search');

console.log("Mongo URI:", process.env.MONGODB_URI); // 👈 测试

const bot = new Telegraf(process.env.BOT_TOKEN);

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

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

    // 扣除积分（仅有结果时）
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

bot.launch();

