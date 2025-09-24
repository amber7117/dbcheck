require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const cookieParser = require('cookie-parser');
const csrf = require('tiny-csrf');
const routes = require('./routes');

const User = require('./models/user');
const QueryLog = require('./models/queryLog');
const search = require('./crawler/search');
const login = require('./crawler/login');
const { assignDepositAddress, checkDeposits } = require('./services/topup');
const logger = require('./utils/logger');
const { toE164 } = require('./normalize');
const { checkAndConsume } = require('./models/rateLimiter');
const { hlrLookup, ntLookup, mnpLookup } = require('./hlrlookup');
const { hlrLookupE164, ntLookupE164, mnpLookupE164 } = require('./service');
const { createTelegramLoginRouter } = require('./login');
// ==== ENV ====
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 8080;
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // 可选，用于自动 setWebhook
const HLR_API_KEY = process.env.HLR_API_KEY || '';
const HLR_API_SECRET = process.env.HLR_API_SECRET || '';

if (!BOT_TOKEN) throw new Error("❌ BOT_TOKEN is missing in environment variables");
if (!MONGODB_URI) throw new Error("❌ MONGODB_URI is missing in environment variables");

// ==== 多语言 (locales) ====
// 你已有 ./locales/en.json / zh.json / my.json
const locales = {
  en: safeRequire('./locales/en.json'),
  zh: safeRequire('./locales/zh.json'),
  my: safeRequire('./locales/my.json'), // 马来语
};
function safeRequire(p) {
  try { return require(p); } catch { return {}; }
}
// 语言映射：Telegram 可能返回 zh-hans/zh-Hant/ms/my 等
function pickLang(codeRaw) {
  const code = (codeRaw || '').toLowerCase();
  if (code.startsWith('zh')) return 'zh';
  if (code.startsWith('ms') || code === 'my') return 'my';
  return 'en';
}
function formatTpl(str, vars = {}) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
}
function tByLang(lang, key, fallback, vars) {
  const dict = locales[lang] || {};
  const val = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict);
  return formatTpl((val ?? fallback ?? key), vars);
}
function tr(ctx, key, fallback, vars) {
  const lang = pickLang(ctx.from?.language_code);
  return tByLang(lang, key, fallback, vars);
}
const htmlEsc = (s = '') => s.toString().replace(/[&<>]/g, ch => ({'&':'&','<':'<','>':'>'}[ch]));

// ==== Stars 套餐（可自行调整）====
const STAR_PACKAGES = [
  { id: 'P100', points: 100, stars: 100, titleKey: 'stars.pkg100.title' },
  { id: 'P300', points: 300, stars: 300, titleKey: 'stars.pkg300.title' },
  { id: 'P1000', points: 1000, stars: 1000, titleKey: 'stars.pkg1000.title' },
  { id: 'SUB_MONTH', stars: 2500, titleKey: 'stars.sub_month.title', subscription: 'monthly' },
  { id: 'SUB_QUARTER', stars: 5000, titleKey: 'stars.sub_quarter.title', subscription: 'quarterly' },
  { id: 'SUB_PERMANENT', stars: 10000, titleKey: 'stars.sub_permanent.title', subscription: 'permanent' },
];

// ==== BOT ====
const bot = new Telegraf(BOT_TOKEN);
const CHANNEL_ID = '@zznets'; // Your channel username

// Function to check if a user is a member of the channel
async function isUserSubscribed(userId) {
  try {
    const member = await bot.telegram.getChatMember(CHANNEL_ID, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (error) {
    console.error('Error checking subscription:', error);
    return false;
  }
}

// ==== Query Queue ====
let queryQueue = Promise.resolve();

// ==== Mongo ====
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

// ==== 启动预热 ====
(async () => {
  try {
    await login();
    await bot.telegram.getMe();
    if (PUBLIC_URL) {
      const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
      await bot.telegram.setWebhook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
      console.log("✅ Webhook set");
    } else {
      console.warn("⚠️ PUBLIC_URL not set, configure webhook manually if using webhooks.");
    }
  } catch (err) {
    console.error("❌ Startup init failed:", err);
  }
})();




// ====== /start ======
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  let user = await User.findOne({ userId });

  if (!user) {
    const subscribed = await isUserSubscribed(userId);
    if (!subscribed) {
      return ctx.reply(
        'Please subscribe to channel to use the bot.',
        Markup.inlineKeyboard([
          [Markup.button.url('Subscribe', 'https://t.me/zznets')],
          [Markup.button.callback('Check Subscription', 'check_subscription')]
        ])
      );
    }

    const inviteMatch = ctx.startPayload?.match(/invite_(\d+)/);
    const invitedBy = inviteMatch ? parseInt(inviteMatch[1]) : null;
    user = new User({ userId, invitedBy, points: 5, subscribed: true });
    await user.save();
    if (invitedBy) {
      await User.findOneAndUpdate({ userId: invitedBy }, { $inc: { points: 3 } });
    }
  } else {
    if (!user.subscribed) {
      const subscribed = await isUserSubscribed(userId);
      if (!subscribed) {
        return ctx.reply(
          'Please subscribe to our channel to use the bot.',
          Markup.inlineKeyboard([
            [Markup.button.url('Subscribe', 'https://t.me/zznets')],
            [Markup.button.callback('Check Subscription', 'check_subscription')]
          ])
        );
      }
      user.subscribed = true;
      await user.save();
    }
  }

  const text =
    `👋 ${tr(ctx, 'start.welcome', 'Welcome!')}\n\n` +
    `${tr(ctx, 'start.id', '🆔 Your ID:')} <code>${userId}</code>\n` +
    `${tr(ctx, 'start.balance', '💰 Current Balance:')} <b>${user.points} points</b>\n\n` +
    `${tr(ctx, 'start.quickQuery', '🔎 Quick Query:')} ` +
    tr(ctx, 'start.quickQuery.tip', 'Send name / phone / ID directly') + `\n\n` +
    `${tr(ctx, 'start.comboQuery', '📑 Combined Query:')}\n` +
    tr(ctx, 'start.comboQuery.examples',
      '/query Ahmad Faizal\n/query 0123456789\n/query 90010111XXXX') +
    `\n\n⚠️ ` + tr(ctx, 'start.fieldsLimit',
      'This bot shows 4 fields: Name / ID Card / Phone / Address. Use Advance for more.');

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💎 ' + tr(ctx, 'ui.advance', 'Advance Search'), 'advance')],
      [Markup.button.callback('💳 ' + tr(ctx, 'ui.recharge', 'Top Up'), 'recharge'),
       Markup.button.callback('❓ ' + tr(ctx, 'ui.help', 'Help'), 'help')],
      [Markup.button.callback('👥 ' + tr(ctx, 'ui.invite', 'Invite'), 'invite'),
       Markup.button.callback('☎️ ' + tr(ctx, 'ui.support', 'Support'), 'support')],
      [Markup.button.callback('📅 Daily Check-in', 'daily_checkin')]
    ])
  });
});

bot.action('check_subscription', async (ctx) => {
  const userId = ctx.from.id;
  const subscribed = await isUserSubscribed(userId);

  if (subscribed) {
    await ctx.answerCbQuery('Thank you for subscribing!');
    let user = await User.findOne({ userId });
    if (!user) {
      user = new User({ userId, points: 5, subscribed: true });
      await user.save();
    } else {
      user.subscribed = true;
      await user.save();
    }
    // Resend the start message
    ctx.update.callback_query.message.text = '/start';
    return bot.handleUpdate(ctx.update);
  } else {
    await ctx.answerCbQuery('You are not subscribed yet.');
  }
});

// ====== Advance Search ======
bot.action('advance', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  if (!user) return ctx.reply(tr(ctx, 'errors.notRegistered', '❌ You are not registered yet. Use /start first.'));

  await ctx.answerCbQuery();
  const msg =
    `💎 <b>${tr(ctx, 'premium.title', 'Advance Search Service')}</b>\n\n` +
    tr(ctx, 'premium.available',
      'Available:\n- 🏠 Address Search\n- 📍 Phone Geo-location\n- 🚗 License Plate Search\n- … and more') +
    `\n\n⚠️ ` + tr(ctx, 'premium.cost', 'Each advance search costs <b>50 points</b>.') + `\n` +
    tr(ctx, 'start.balance', '💰 Current Balance:') + ` <b>${user.points} points</b>\n\n` +
    tr(ctx, 'premium.confirm', 'Do you want to proceed?');

  await ctx.reply(msg, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ ' + tr(ctx, 'ui.confirm50', 'Confirm (50 points)'), 'confirm_advance')],
      [Markup.button.callback('❌ ' + tr(ctx, 'ui.cancel', 'Cancel'), 'cancel_advance')]
    ])
  });
});

bot.action('confirm_advance', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  if (!user) return ctx.reply(tr(ctx, 'errors.notRegistered', '❌ You are not registered yet. Use /start first.'));

  if (user.points < 50) {
    await ctx.answerCbQuery();
    return ctx.reply(tr(ctx, 'errors.noPoints', '❌ Insufficient balance. Please recharge.'));
  }

  await User.updateOne({ userId }, { $inc: { points: -50 } });
  await new QueryLog({ userId, query: '[Advance Search Requested]', results: 0, success: true }).save();

  await ctx.answerCbQuery();
  await ctx.reply(tr(ctx, 'premium.afterPay',
    '✅ 50 points deducted. Please provide your premium search details to @dbcheck.'));
});

bot.action('cancel_advance', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  let user = await User.findOne({ userId });
  if (!user) { user = new User({ userId, points: 0 }); await user.save(); }
  const text =
    `👋 ${tr(ctx, 'start.welcomeBack', 'Welcome back')}\n\n` +
    `${tr(ctx, 'start.id', '🆔 Your ID:')} <code>${userId}</code>\n` +
    `${tr(ctx, 'start.balance', '💰 Current Balance:')} <b>${user.points} points</b>\n\n` +
    `${tr(ctx, 'start.quickQuery', '🔎 Quick Query:')} ` + tr(ctx, 'start.quickQuery.tip', 'Send name / phone / ID directly') + `\n\n` +
    `${tr(ctx, 'start.comboQuery', '📑 Combined Query:')}\n` +
    tr(ctx, 'start.comboQuery.examples',
      '/query Ahmad faizal \n/query <idcard number> \n/query 0123456789') +
    `\n\n⚠️ ` + tr(ctx, 'start.fieldsLimit',
      'This bot shows 4 fields: Name / ID Card / Phone / Address. Use Premium for more.');
  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💎 ' + tr(ctx, 'ui.advance', 'Advance Search'), 'advance')],
      [Markup.button.callback('💳 ' + tr(ctx, 'ui.recharge', 'Top Up'), 'recharge'),
       Markup.button.callback('❓ ' + tr(ctx, 'ui.help', 'Help'), 'help')],
      [Markup.button.callback('👥 ' + tr(ctx, 'ui.invite', 'Invite'), 'invite'),
       Markup.button.callback('☎️ ' + tr(ctx, 'ui.support', 'Support'), 'support')]
    ])
  });
});

// ====== /balance ======
bot.command('balance', async (ctx) => {
  const user = await User.findOne({ userId: ctx.from.id });
  if (!user) return ctx.reply(tr(ctx, 'errors.notRegistered', '❌ You are not registered yet. Use /start first.'));
  return ctx.reply(`${tr(ctx, 'start.balance', '💰 Current Balance:')} <b>${user.points} points</b>`, { parse_mode: 'HTML' });
});

// ====== /query （普通查询，成功才扣 1 点：原子更新 & 分块发送）======
bot.command('query', (ctx) => {
  queryQueue = queryQueue.then(async () => {
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    const hasSubscription = user.subscriptionType &&
      (user.subscriptionType === 'permanent' || new Date() < user.subscriptionExpiresAt);

    if (!user || (!hasSubscription && user.points <= 0)) {
      await new QueryLog({ userId, query: ctx.message.text, resultCount: 0, success: false }).save();
      return ctx.reply(tr(ctx, 'errors.noPoints', '❌ You don’t have enough points. Please recharge.'));
    }

    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply(tr(ctx, 'query.usage', 'Please provide a search query, e.g. `/query John Smith`'), { parse_mode: 'Markdown' });

    const queryText = args.join(' ');
    const waitMsg = await ctx.reply('🔍 ' + tr(ctx, 'ui.searching', 'Searching, please wait...'));

    try {
      const resultOutput = await search(queryText);
      try { await ctx.deleteMessage(waitMsg.message_id); } catch {}

      if (resultOutput === 'No results found.') {
        await new QueryLog({ userId, query: queryText, resultCount: 0, success: false }).save();
        return ctx.reply('⚠️ ' + tr(ctx, 'query.noResult', 'No matching results found. No points deducted.'));
      }
      if (resultOutput.startsWith('An error occurred')) {
        await new QueryLog({ userId, query: queryText, resultCount: 0, success: false }).save();
        return ctx.reply('❌ ' + tr(ctx, 'errors.searchError', 'Error occurred while searching. Please try again later.'));
      }

      const hasSubscription = user.subscriptionType &&
        (user.subscriptionType === 'permanent' || new Date() < user.subscriptionExpiresAt);

      if (!hasSubscription) {
        const dec = await User.findOneAndUpdate(
          { userId, points: { $gte: 1 } },
          { $inc: { points: -1 } },
          { new: true }
        );
        if (!dec) {
          await new QueryLog({ userId, query: queryText, resultCount: 0, success: false }).save();
          return ctx.reply(tr(ctx, 'errors.noPoints', '❌ You don’t have enough points. Please recharge.'));
        }
      }

      const lines = resultOutput.split('\n');
      const log = await new QueryLog({ userId, query: queryText, resultCount: lines.length, resultText: resultOutput, success: true }).save();

      const itemsPerPage = 10;
      const totalPages = Math.ceil(lines.length / itemsPerPage);
      const page = 1;
      const pageContent = lines.slice(0, itemsPerPage).join('\n');

      const markup = Markup.inlineKeyboard([
        [
          Markup.button.callback(`Page ${page}/${totalPages}`, 'noop'),
          Markup.button.callback('Next >', `page_${log._id}_${page + 1}`)
        ],
        [Markup.button.callback('Download All', `download_${log._id}`)]
      ]);

      await ctx.reply(`<pre>${htmlEsc(pageContent)}</pre>`, {
        parse_mode: 'HTML',
        ...markup
      });

    } catch (e) {
      console.error(e);
      await new QueryLog({ userId, query: queryText, resultCount: 0, success: false }).save();
      await ctx.reply('❌ ' + tr(ctx, 'errors.searchError', 'Error occurred while searching. Please try again later.'));
    }
  }).catch(err => {
    console.error("Error in query queue:", err);
    ctx.reply('❌ An unexpected error occurred in the processing queue.');
  });
});

bot.action(/page_(.+)_(\d+)/, async (ctx) => {
  const logId = ctx.match[1];
  const page = parseInt(ctx.match[2]);

  const log = await QueryLog.findById(logId);
  if (!log) {
    return ctx.answerCbQuery('Query not found.');
  }

  const lines = log.resultText.split('\n');
  const itemsPerPage = 10;
  const totalPages = Math.ceil(lines.length / itemsPerPage);

  if (page < 1 || page > totalPages) {
    return ctx.answerCbQuery('Invalid page number.');
  }

  const start = (page - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const pageContent = lines.slice(start, end).join('\n');

  const buttons = [];
  if (page > 1) {
    buttons.push(Markup.button.callback('< Prev', `page_${logId}_${page - 1}`));
  }
  buttons.push(Markup.button.callback(`Page ${page}/${totalPages}`, 'noop'));
  if (page < totalPages) {
    buttons.push(Markup.button.callback('Next >', `page_${logId}_${page + 1}`));
  }

  await ctx.editMessageText(`<pre>${htmlEsc(pageContent)}</pre>`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([buttons, [Markup.button.callback('Download All', `download_${logId}`)]])
  });
});

bot.action(/download_(.+)/, async (ctx) => {
  const logId = ctx.match[1];
  const log = await QueryLog.findById(logId);

  if (!log) {
    return ctx.answerCbQuery('Query not found.');
  }

  const filePath = path.join(__dirname, `${logId}.txt`);
  require('fs').writeFileSync(filePath, log.resultText);

  await ctx.replyWithDocument({ source: filePath });
  require('fs').unlinkSync(filePath); // Clean up the file
});

bot.action('noop', (ctx) => ctx.answerCbQuery());

// ====== /lookup （HLR 查询，成功才扣 1 点）======
bot.command('lookup', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  if (!user) return ctx.reply(tr(ctx, 'errors.notRegistered', '❌ You are not registered yet. Use /start first.'));
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) return ctx.reply(tr(ctx, 'lookup.usage', 'Usage: /lookup <phone-in-international-format>'));

  if (!HLR_API_KEY || !HLR_API_SECRET) {
    return ctx.reply('❌ ' + tr(ctx, 'lookup.apiMissing', 'HLR API key/secret not configured.'));
  }

  const msisdn = args[0].replace(/[^\d+]/g, '');
  const waitMsg = await ctx.reply('📡 ' + tr(ctx, 'lookup.querying', 'Querying HLR, please wait...'));

  try {
    const res = await hlrLookup(msisdn, { apiKey: HLR_API_KEY, apiSecret: HLR_API_SECRET });

    // 仅当查询成功 & 有结果 才尝试扣 1 点
    const dec = await User.findOneAndUpdate(
      { userId, points: { $gte: 1 } },
      { $inc: { points: -1 } },
      { new: true }
    );
    if (!dec) {
      try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
      return ctx.reply(tr(ctx, 'errors.noPoints', '❌ You don’t have enough points. Please recharge.'));
    }

    try { await ctx.deleteMessage(waitMsg.message_id); } catch {}

    const mp = res.mobile_phone || res; // 兼容形态
    const lines = [];
    const add = (label, val) => {
      if (val !== null && val !== undefined && val !== '') {
        lines.push(`<b>${htmlEsc(label)}:</b> ${htmlEsc(val)}`);
      }
    };

    add(tr(ctx, 'lookup.fields.id', '查询ID'), mp.id);
    add(tr(ctx, 'lookup.fields.msisdn', '手机号码'), mp.msisdn || msisdn);
    add(tr(ctx, 'lookup.fields.status', '连接状态'), mp.connectivity_status);
    add(tr(ctx, 'lookup.fields.mccmnc', 'MCCMNC'), mp.mccmnc);
    add(tr(ctx, 'lookup.fields.mcc', '移动国家码'), mp.mcc);
    add(tr(ctx, 'lookup.fields.mnc', '移动网络码'), mp.mnc);
    add(tr(ctx, 'lookup.fields.imsi', 'IMSI'), mp.imsi);
    add(tr(ctx, 'lookup.fields.msin', 'MSIN'), mp.msin);
    add(tr(ctx, 'lookup.fields.msc', 'MSC'), mp.msc);
    add(tr(ctx, 'lookup.fields.original_network', '原始网络名称'), mp.original_network_name);
    add(tr(ctx, 'lookup.fields.original_country', '原始国家'), `${mp.original_country_name} / ${mp.original_country_code} / ${mp.original_country_prefix}`);
    if (typeof mp.is_ported === 'boolean') {
      add(tr(ctx, 'lookup.fields.ported', '是否携号转网'), mp.is_ported ? tr(ctx, 'ui.yes', 'YES') : tr(ctx, 'ui.no', 'NO'));
    }
    add(tr(ctx, 'lookup.fields.ported_network', '现网名称'), mp.ported_network_name);
    if (mp.ported_country_name) {
      add(tr(ctx, 'lookup.fields.ported_country', '现网国家'), `${mp.ported_country_name} / ${mp.ported_country_code} / ${mp.ported_country_prefix}`);
    }
    if (typeof mp.is_roaming === 'boolean') {
      add(tr(ctx, 'lookup.fields.roaming', '是否漫游'), mp.is_roaming ? tr(ctx, 'ui.yes', 'YES') : tr(ctx, 'ui.no', 'NO'));
    }
    add(tr(ctx, 'lookup.fields.roaming_network', '漫游网络'), mp.roaming_network_name);

    const body =
      `✅ ${tr(ctx,'lookup.done','HLR lookup result')}:\n\n` +
      `<blockquote>${lines.join('\n')}</blockquote>`;

    await ctx.reply(body, { parse_mode: 'HTML' });

    await new QueryLog({ userId, query: `[HLR] ${msisdn}`, results: 1, success: true }).save();

  } catch (err) {
    console.error('HLR error:', err);
    try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
    await new QueryLog({ userId, query: `[HLR] ${msisdn}`, results: 0, success: false }).save();
    await ctx.reply('❌ ' + tr(ctx, 'lookup.fail', 'HLR request failed. Please try again later.'));
  }
});

// ====== /ntlookup (Number Type Lookup) ======
bot.command('ntlookup', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  if (!user) return ctx.reply(tr(ctx, 'errors.notRegistered', '❌ You are not registered yet. Use /start first.'));
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) return ctx.reply(tr(ctx, 'lookup.usage', 'Usage: /ntlookup <phone-in-international-format>'));

  if (!HLR_API_KEY || !HLR_API_SECRET) {
    return ctx.reply('❌ ' + tr(ctx, 'lookup.apiMissing', 'HLR API key/secret not configured.'));
  }

  const number = args[0].replace(/[^\d+]/g, '');
  const waitMsg = await ctx.reply('📡 ' + tr(ctx, 'lookup.querying', 'Querying Number Type, please wait...'));

  try {
    const res = await ntLookup(number, { apiKey: HLR_API_KEY, apiSecret: HLR_API_SECRET });

    const dec = await User.findOneAndUpdate(
      { userId, points: { $gte: 1 } },
      { $inc: { points: -1 } },
      { new: true }
    );
    if (!dec) {
      try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
      return ctx.reply(tr(ctx, 'errors.noPoints', '❌ You don’t have enough points. Please recharge.'));
    }

    try { await ctx.deleteMessage(waitMsg.message_id); } catch {}

    const lines = [];
    const add = (label, val) => val && lines.push(`<b>${htmlEsc(label)}:</b> ${htmlEsc(val)}`);

    add(tr(ctx, 'lookup.fields.number', 'Number'), res.number);
    add(tr(ctx, 'lookup.fields.number_type', 'Number Type'), res.number_type);
    add(tr(ctx, 'lookup.fields.original_country', 'Country'), res.original_country_name);
    add(tr(ctx, 'lookup.fields.original_network', 'Original Network'), res.original_network_name);

    const body =
      `✅ ${tr(ctx,'lookup.done','Number Type lookup result')}:\n\n` +
      `<blockquote>${lines.join('\n')}</blockquote>`;

    await ctx.reply(body, { parse_mode: 'HTML' });

    await new QueryLog({ userId, query: `[NT] ${number}`, results: 1, success: true }).save();

  } catch (err) {
    console.error('NT error:', err);
    try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
    await new QueryLog({ userId, query: `[NT] ${number}`, results: 0, success: false }).save();
    await ctx.reply('❌ ' + tr(ctx, 'lookup.fail', 'NT request failed. Please try again later.'));
  }
});

// ====== /mnplookup (MNP Lookup) ======
bot.command('mnplookup', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  if (!user) return ctx.reply(tr(ctx, 'errors.notRegistered', '❌ You are not registered yet. Use /start first.'));
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) return ctx.reply(tr(ctx, 'lookup.usage', 'Usage: /mnplookup <phone-in-international-format>'));

  if (!HLR_API_KEY || !HLR_API_SECRET) {
    return ctx.reply('❌ ' + tr(ctx, 'lookup.apiMissing', 'HLR API key/secret not configured.'));
  }

  const msisdn = args[0].replace(/[^\d+]/g, '');
  const waitMsg = await ctx.reply('📡 ' + tr(ctx, 'lookup.querying', 'Querying MNP, please wait...'));

  try {
    const res = await mnpLookup(msisdn, { apiKey: HLR_API_KEY, apiSecret: HLR_API_SECRET });

    const dec = await User.findOneAndUpdate(
      { userId, points: { $gte: 1 } },
      { $inc: { points: -1 } },
      { new: true }
    );
    if (!dec) {
      try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
      return ctx.reply(tr(ctx, 'errors.noPoints', '❌ You don’t have enough points. Please recharge.'));
    }

    try { await ctx.deleteMessage(waitMsg.message_id); } catch {}

    const lines = [];
    const add = (label, val) => val && lines.push(`<b>${htmlEsc(label)}:</b> ${htmlEsc(val)}`);

    add(tr(ctx, 'lookup.fields.msisdn', 'MSISDN'), res.msisdn);
    add(tr(ctx, 'lookup.fields.original', 'Original Network'), res.original_network_name);
    add(tr(ctx, 'lookup.fields.current', 'Current Network'), res.ported_network_name);
    if (typeof res.is_ported === 'boolean') {
      add(tr(ctx, 'lookup.fields.ported', 'Ported'), res.is_ported ? tr(ctx, 'ui.yes', 'YES') : tr(ctx, 'ui.no', 'NO'));
    }

    const body =
      `✅ ${tr(ctx,'lookup.done','MNP lookup result')}:\n\n` +
      `<blockquote>${lines.join('\n')}</blockquote>`;

    await ctx.reply(body, { parse_mode: 'HTML' });

    await new QueryLog({ userId, query: `[MNP] ${msisdn}`, results: 1, success: true }).save();

  } catch (err) {
    console.error('MNP error:', err);
    try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
    await new QueryLog({ userId, query: `[MNP] ${msisdn}`, results: 0, success: false }).save();
    await ctx.reply('❌ ' + tr(ctx, 'lookup.fail', 'MNP request failed. Please try again later.'));
  }
});

// ====== 文本直接转 /query ======
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  ctx.message.text = `/query ${ctx.message.text}`;
  return bot.handleUpdate(ctx.update);
});

bot.command('addpoints', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  if (!user || !user.isAdmin) {
    return ctx.reply('You are not authorized to use this command.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /addpoints <userId> <points>');
  }

  const targetUserId = args[0];
  const points = parseInt(args[1], 10);

  if (isNaN(points)) {
    return ctx.reply('Invalid points value.');
  }

  try {
    const targetUser = await User.findOneAndUpdate({ userId: targetUserId }, { $inc: { points } }, { new: true });
    if (!targetUser) {
      return ctx.reply('User not found.');
    }
    ctx.reply(`Successfully added ${points} points to user ${targetUserId}. New balance: ${targetUser.points}`);
  } catch (error) {
    console.error('Error adding points:', error);
    ctx.reply('Failed to add points.');
  }
});

async function guard(ctx) {
  const userId = String(ctx.from.id);
  const rate = await checkAndConsume(userId);
  if (!rate.allowed) {
    await ctx.reply('请求过于频繁，请稍后再试（已达每分钟上限）。');
    return false;
  }
  return true;
}

function render(obj) {
  // 简单渲染，可按你需要展开字段
  return '```\n' + JSON.stringify(obj, null, 2) + '\n```';
}

bot.command('hlr', async (ctx) => {
  if (!await guard(ctx)) return;
  const parts = ctx.message.text.split(/\s+/);
  const input = parts[1];
  const e164 = toE164(input);
  if (!e164) return ctx.reply('请输入有效号码，例如：/hlr +60123456789');

  try {
    const { cache, data } = await hlrLookupE164(e164);
    await ctx.replyWithMarkdown(`HLR 结果 (${cache ? '缓存' : '实时'}):\n${render(data)}`);
  } catch (e) {
    logger.error(e);
    await ctx.reply('查询失败：' + (e?.response?.data?.message || e.message));
  }
});

bot.command('nt', async (ctx) => {
  if (!await guard(ctx)) return;
  const parts = ctx.message.text.split(/\s+/);
  const e164 = toE164(parts[1]);
  if (!e164) return ctx.reply('请输入有效号码，例如：/nt +60123456789');

  try {
    const { cache, data } = await ntLookupE164(e164);
    await ctx.replyWithMarkdown(`NT 结果 (${cache ? '缓存' : '实时'}):\n${render(data)}`);
  } catch (e) {
    await ctx.reply('查询失败：' + (e?.response?.data?.message || e.message));
  }
});

bot.command('mnp', async (ctx) => {
  if (!await guard(ctx)) return;
  const parts = ctx.message.text.split(/\s+/);
  const e164 = toE164(parts[1]);
  if (!e164) return ctx.reply('请输入有效号码，例如：/mnp +60123456789');

  try {
    const { cache, data } = await mnpLookupE164(e164);
    await ctx.replyWithMarkdown(`MNP 结果 (${cache ? '缓存' : '实时'}):\n${render(data)}`);
  } catch (e) {
    await ctx.reply('查询失败：' + (e?.response?.data?.message || e.message));
  }
});

// ====== 充值：汇总入口（USDT / Stars）======
bot.action('recharge', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  let user = await User.findOne({ userId });
  if (!user) { user = new User({ userId, points: 0 }); await user.save(); }

  await ctx.reply(tr(ctx,'recharge.choose','Choose a top-up method:'), Markup.inlineKeyboard([
    [Markup.button.callback('💫 Telegram Stars', 'recharge_stars')],
    [Markup.button.callback('💳 USDT-TRC20', 'recharge_usdt')],
  ]));
});

// ====== USDT 充值（原有功能保留）======
bot.action('recharge_usdt', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  let user = await User.findOne({ userId });
  if (!user) { user = new User({ userId, points: 0 }); await user.save(); }

  const addr = await assignDepositAddress(user);
  const msg =
`💳 <b>USDT-TRC20</b> (${tr(ctx,'recharge.usdt','Recharge')})

${tr(ctx,'recharge.sendAtLeast','Send at least')} <b>100 USDT</b> ${tr(ctx,'recharge.to','to')}:
<code>${addr}</code>

1 USDT = 1 ${tr(ctx,'points','point')}
⚠️ ${tr(ctx,'recharge.min','Minimum deposit = 100 USDT')}
${tr(ctx,'recharge.autoUpdate','Your balance will update automatically after confirmation.')}`;

  await ctx.reply(msg, { parse_mode: 'HTML' });
});

// ====== Stars 充值（sendInvoice: currency: XTR）======
bot.action('recharge_stars', async (ctx) => {
  await ctx.answerCbQuery();
  const buttons = STAR_PACKAGES.map(p =>
    [Markup.button.callback(`⭐ ${p.stars} → +${p.points} ${tr(ctx,'points','points')}`, `buy_${p.id}`)]
  );
  await ctx.reply(tr(ctx,'recharge.stars.pick','Pick a Stars package:'), Markup.inlineKeyboard(buttons));
});

for (const pkg of STAR_PACKAGES) {
  bot.action(`buy_${pkg.id}`, async (ctx) => {
    await ctx.answerCbQuery();

    const title = tByLang(pickLang(ctx.from?.language_code), pkg.titleKey, `${pkg.points} Points`);
    const description = tr(ctx,'recharge.stars.desc','Top up points by paying with Telegram Stars');
    const payloadObj = { kind: 'stars_points', pkgId: pkg.id, points: pkg.points, stars: pkg.stars, uid: String(ctx.from.id) };
    const payload = JSON.stringify(payloadObj);

    try {
      await ctx.replyWithInvoice({
        title,
        description,
        payload,
        provider_token: '',     // Stars 支付必须留空
        currency: 'XTR',        // Stars 货币码
        prices: [{ label: `${pkg.points} ${tr(ctx,'points','points')}`, amount: pkg.stars }], // Stars: 只能 1 条 price
      });
    } catch (e) {
      console.error('sendInvoice error:', e);
      await ctx.reply('❌ ' + tr(ctx,'recharge.stars.fail','Failed to create Stars invoice.'));
    }
  });
}

// Stars 预结算（通常直接允许通过）
bot.on('pre_checkout_query', async (ctx) => {
  try { await ctx.answerPreCheckoutQuery(true); } catch (e) { console.error(e); }
});

// Stars 支付成功回调：加点 & 记录
bot.on('successful_payment', async (ctx) => {
  try {
    const sp = ctx.message.successful_payment;
    if (sp?.currency !== 'XTR') return; // 仅处理 Stars
    let payload = {};
    try { payload = JSON.parse(sp.invoice_payload || '{}'); } catch {}
    if (payload.kind !== 'stars_points') return;

    const userId = ctx.from.id;
    const pkg = STAR_PACKAGES.find(p => p.id === payload.pkgId);

    if (pkg.subscription) {
      let expiresAt = null;
      if (pkg.subscription === 'monthly') {
        expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 1);
      } else if (pkg.subscription === 'quarterly') {
        expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 3);
      }

      await User.updateOne({ userId }, {
        subscriptionType: pkg.subscription,
        subscriptionExpiresAt: expiresAt
      });

      await new QueryLog({
        userId,
        query: `[Subscription] ${pkg.subscription} / ${sp.total_amount} XTR`,
        success: true
      }).save();

      await ctx.reply(`✅ Payment received. You now have a ${pkg.subscription} subscription.`);
    } else {
      const points = Number(payload.points) || 0;
      if (points > 0) {
        await User.updateOne({ userId }, { $inc: { points } });
        await new QueryLog({
          userId,
          query: `[Stars] ${points}p / ${sp.total_amount} XTR`,
          resultCount: 0,
          success: true
        }).save();

        await ctx.reply(`✅ ${tr(ctx,'recharge.stars.success','Payment received. Points added:')} <b>+${points}</b>`, { parse_mode: 'HTML' });
      }
    }
  } catch (e) {
    console.error('successful_payment handler error:', e);
  }
});

// ====== 其他回调 ======
bot.action('help', async (ctx) => {
  const user = await User.findOne({ userId: ctx.from.id });
  await ctx.answerCbQuery();
  const msg =
`💰 ${tr(ctx,'start.balance','Current Balance:')} ${user?.points || 0}

📖 ${tr(ctx,'help.howTo','How to Use')}:
1️⃣ ${tr(ctx,'help.quick','Quick: send name/ID/phone directly')}
2️⃣ ${tr(ctx,'help.combo','Combined: /query with multiple params')}
3️⃣ ${tr(ctx,'help.cost','Each successful query deducts 1 point')}
4️⃣ ${tr(ctx,'help.noDeduct','No deduction if no results')}
5️⃣ ${tr(ctx,'help.invite','Invite friends to earn free points')}
6️⃣ ${tr(ctx,'help.premium','Advance searches cost 50 points')}`;

  await ctx.reply(msg);
});

bot.action('invite', async (ctx) => {
  await ctx.answerCbQuery();
  const me = await bot.telegram.getMe();
  const inviteLink = `https://t.me/${me.username}?start=invite_${ctx.from.id}`;
  await ctx.reply(`👥 ${tr(ctx,'invite.text','Invite friends and earn 3 points per signup.')}
${tr(ctx,'invite.link','Your referral link:')}
${inviteLink}`);
});

bot.action('daily_checkin', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });

  if (!user) {
    return ctx.answerCbQuery(tr(ctx, 'errors.notRegistered', '❌ You are not registered yet. Use /start first.'));
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (user.lastCheckin && user.lastCheckin >= today) {
    return ctx.answerCbQuery('You have already checked in today.');
  }

  user.points += 1;
  user.lastCheckin = now;
  await user.save();

  await ctx.answerCbQuery(`You've received 1 point for checking in! Your new balance is ${user.points} points.`);
});

bot.action('support', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('☎️ Contact support: @dbcheck');
});

// ====== 错误兜底 ======
bot.catch((err, ctx) => {
  console.error(`❌ Error at update ${ctx.updateType}:`, err);
});

// ====== Express / Webhook ======
const app = express();
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGODB_URI })
}));
app.use(csrf(
  "12345678901234567890123456789012", // secret
  ["POST"], // methods
  ["/webhook/*"] // ignored paths
));

app.use(bot.webhookCallback(WEBHOOK_PATH));
app.use('/', routes);

const loginRouter = createTelegramLoginRouter({
  botToken: process.env.BOT_TOKEN,
  botUsername: process.env.BOT_USERNAME,
  successRedirect: '/dashboard'
});
app.use(loginRouter);

// 可选：把定时充值扫描改为 Cloud Scheduler 调用这个路由
app.post("/cron/check-deposits", async (req, res) => {
  try { await checkDeposits(bot); res.status(200).send("ok"); }
  catch (e) { console.error(e); res.status(500).send("err"); }
});

// 若仍想用轮询（注意多副本重复执行风险）
const timer = setInterval(() => checkDeposits(bot), 30000);

app.listen(PORT, () => {
  console.log(`✅ Server on :${PORT}`);
  if (PUBLIC_URL) console.log(`📡 Webhook path: ${PUBLIC_URL}${WEBHOOK_PATH}`);
});

// 优雅关停
process.once('SIGINT', () => { clearInterval(timer); mongoose.disconnect().finally(()=>process.exit(0)); });
process.once('SIGTERM', () => { clearInterval(timer); mongoose.disconnect().finally(()=>process.exit(0)); });
