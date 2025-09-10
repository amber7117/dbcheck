// bot.js  —  merged & fixed (index.js + bot.js)
// -------------------------------------------------
require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');

const User = require('./models/user');
const QueryLog = require('./models/queryLog');
const search = require('./crawler/search');
const login = require('./crawler/login');
const { assignDepositAddress, checkDeposits } = require('./services/topup');
const logger = require('./logger');
const { toE164 } = require('./normalize');
const { checkAndConsume } = require('./models/rateLimiter');
const { hlrLookupE164, ntLookupE164, mnpLookupE164 } = require('./service');

// ==== ENV ====
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 8080;
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // 有则走 webhook
const ENABLE_DEPOSIT_CRON = process.env.ENABLE_DEPOSIT_CRON === '1';

if (!BOT_TOKEN) throw new Error('❌ BOT_TOKEN is missing');
if (!MONGODB_URI) throw new Error('❌ MONGODB_URI is missing');

// ==== 多语言 (locales) ====
function safeRequire(p) { try { return require(p); } catch { return {}; } }
const locales = {
  en: safeRequire('./locales/en.json'),
  zh: safeRequire('./locales/zh.json'),
  my: safeRequire('./locales/my.json'),
};
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
const htmlEsc = (s = '') => s.toString().replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

// ==== Stars 套餐 ====
const STAR_PACKAGES = [
  { id: 'P100', points: 100, stars: 100, titleKey: 'stars.pkg100.title' },
  { id: 'P300', points: 300, stars: 300, titleKey: 'stars.pkg300.title' },
  { id: 'P1000', points: 1000, stars: 1000, titleKey: 'stars.pkg1000.title' },
];

// ==== BOT ====
const bot = new Telegraf(BOT_TOKEN);

// ==== Mongo ====
mongoose.connect(MONGODB_URI, { autoIndex: true })
  .then(() => logger.info('Mongo connected'))
  .catch(err => { logger.error(err, 'Mongo connect failed'); process.exit(1); });

// ==== 启动预热 ====
(async () => {
  try {
    await login().catch(e => logger.warn({ err: e }, 'login() warmup failed (non-blocking)'));
    await bot.telegram.getMe();
    if (PUBLIC_URL) {
      // webhook 模式
      const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
      await bot.telegram.setWebhook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
      logger.info({ url: `${PUBLIC_URL}${WEBHOOK_PATH}` }, 'Webhook set');
    } else {
      // long polling 模式
      await bot.launch();
      logger.info('Bot launched (long polling)');
    }
  } catch (err) {
    logger.error({ err }, 'Startup init failed');
  }
})();

// ====== /start ======
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  let user = await User.findOne({ userId });

  if (!user) {
    const inviteMatch = ctx.startPayload?.match(/invite_(\d+)/);
    const invitedBy = inviteMatch ? parseInt(inviteMatch[1]) : null;
    user = new User({ userId, invitedBy, points: 5 });
    await user.save();
    if (invitedBy) await User.findOneAndUpdate({ userId: invitedBy }, { $inc: { points: 1 } });
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
      [Markup.button.callback('💎 ' + tr(ctx, 'ui.premium', 'Premium Search'), 'premium')],
      [Markup.button.callback('💳 ' + tr(ctx, 'ui.recharge', 'Top Up'), 'recharge'),
       Markup.button.callback('❓ ' + tr(ctx, 'ui.help', 'Help'), 'help')],
      [Markup.button.callback('👥 ' + tr(ctx, 'ui.invite', 'Invite'), 'invite'),
       Markup.button.callback('☎️ ' + tr(ctx, 'ui.support', 'Support'), 'support')]
    ])
  });
});

// ====== Premium Search ======
bot.action('premium', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  if (!user) return ctx.reply(tr(ctx, 'errors.notRegistered', '❌ You are not registered yet. Use /start first.'));

  await ctx.answerCbQuery();
  const msg =
    `💎 <b>${tr(ctx, 'premium.title', 'Premium Search Service')}</b>\n\n` +
    tr(ctx, 'premium.available',
      'Available:\n- 🏠 Address Search\n- 📍 Phone Geo-location\n- 🚗 License Plate Search\n- … and more') +
    `\n\n⚠️ ` + tr(ctx, 'premium.cost', 'Each premium search costs <b>50 points</b>.') + `\n` +
    tr(ctx, 'start.balance', '💰 Current Balance:') + ` <b>${user.points} points</b>\n\n` +
    tr(ctx, 'premium.confirm', 'Do you want to proceed?');

  await ctx.reply(msg, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ ' + tr(ctx, 'ui.confirm50', 'Confirm (50 points)'), 'confirm_premium')],
      [Markup.button.callback('❌ ' + tr(ctx, 'ui.cancel', 'Cancel'), 'cancel_premium')]
    ])
  });
});

bot.action('confirm_premium', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  if (!user) return ctx.reply(tr(ctx, 'errors.notRegistered', '❌ You are not registered yet. Use /start first.'));

  if (user.points < 50) {
    await ctx.answerCbQuery();
    return ctx.reply(tr(ctx, 'errors.noPoints', '❌ Insufficient balance. Please recharge.'));
  }

  await User.updateOne({ userId }, { $inc: { points: -50 } });
  await new QueryLog({ userId, query: '[Premium Search Requested]', results: 0, success: true }).save();

  await ctx.answerCbQuery();
  await ctx.reply(tr(ctx, 'premium.afterPay',
    '✅ 50 points deducted. Please provide your premium search details to @dbcheck.'));
});

bot.action('cancel_premium', async (ctx) => {
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
      [Markup.button.callback('💎 ' + tr(ctx, 'ui.premium', 'Premium Search'), 'premium')],
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

// ====== /query （成功才扣 1 点；健壮处理 search() 返回类型）======
let queryQueue = Promise.resolve();

// 统一规范 search() 输出
function normalizeSearchOutput(resultOutput) {
  // null/undefined
  if (resultOutput == null) return { type: 'empty', text: '' };

  // Buffer
  if (Buffer.isBuffer(resultOutput)) {
    const s = resultOutput.toString('utf8');
    return { type: 'text', text: s };
  }

  // 对象
  if (typeof resultOutput === 'object') {
    // 常见形态：{ error }, { message }, { filePath }, { text }
    if (resultOutput.error) return { type: 'error', text: String(resultOutput.error) };
    if (resultOutput.message && typeof resultOutput.message === 'string') {
      const msg = resultOutput.message;
      // 简单猜测是否文件提示
      if (/saved to/i.test(msg) && /\.txt/i.test(msg)) {
        const m = msg.match(/(?:to|saved to):?\s*(.+\.txt)/i);
        return { type: m ? 'file' : 'text', text: msg, filePath: m ? m[1] : undefined };
      }
      return { type: 'text', text: msg };
    }
    if (resultOutput.filePath) return { type: 'file', text: 'Result saved to file', filePath: String(resultOutput.filePath) };
    if (resultOutput.text) return { type: 'text', text: String(resultOutput.text) };
    return { type: 'text', text: JSON.stringify(resultOutput) };
  }

  // 字符串
  if (typeof resultOutput === 'string') {
    const s = resultOutput.trim();
    if (!s) return { type: 'empty', text: '' };
    if (/^no results? found\.?$/i.test(s)) return { type: 'empty', text: s };
    if (/^an error occurred/i.test(s)) return { type: 'error', text: s };
    // 文件提示："... Saved to: /path/file.txt"
    const fileMatch = s.match(/saved to:\s*(.+\.txt)/i);
    if (fileMatch) return { type: 'file', text: s, filePath: fileMatch[1] };
    if (s.endsWith('.txt')) return { type: 'file', text: s, filePath: s };
    return { type: 'text', text: s };
  }

  // 其他类型
  return { type: 'text', text: String(resultOutput) };
}

bot.command('query', (ctx) => {
  queryQueue = queryQueue.then(async () => {
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });
    if (!user || user.points <= 0) {
      await new QueryLog({ userId, query: ctx.message.text, results: 0, success: false }).save();
      return ctx.reply(tr(ctx, 'errors.noPoints', '❌ You don’t have enough points. Please recharge.'));
    }

    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) {
      return ctx.reply(tr(ctx, 'query.usage', 'Please provide a search query, e.g. `/query John Smith`'), { parse_mode: 'Markdown' });
    }

    const queryText = args.join(' ');
    const waitMsg = await ctx.reply('🔍 ' + tr(ctx, 'ui.searching', 'Searching, please wait...'));

    try {
      const raw = await search(queryText);
      try { await ctx.deleteMessage(waitMsg.message_id); } catch {}

      const out = normalizeSearchOutput(raw);

      if (out.type === 'empty') {
        await new QueryLog({ userId, query: queryText, results: 0, success: false }).save();
        return ctx.reply('⚠️ ' + tr(ctx, 'query.noResult', 'No matching results found. No points deducted.'));
      }
      if (out.type === 'error') {
        await new QueryLog({ userId, query: queryText, results: 0, success: false }).save();
        return ctx.reply('❌ ' + tr(ctx, 'errors.searchError', 'Error occurred while searching. Please try again later.'));
      }

      // 仅成功才扣 1 点（原子）
      const dec = await User.findOneAndUpdate(
        { userId, points: { $gte: 1 } },
        { $inc: { points: -1 } },
        { new: true }
      );
      if (!dec) {
        await new QueryLog({ userId, query: queryText, results: 0, success: false }).save();
        return ctx.reply(tr(ctx, 'errors.noPoints', '❌ You don’t have enough points. Please recharge.'));
      }
      await new QueryLog({ userId, query: queryText, results: 1, success: true }).save();

      if (out.type === 'file' && out.filePath) {
        await ctx.reply(tr(ctx, 'query.long', 'The result is too long. Saved to file below:'));
        await ctx.replyWithDocument({ source: out.filePath });
      } else {
        await ctx.reply(`<pre>${htmlEsc(out.text)}</pre>`, { parse_mode: 'HTML' });
      }
    } catch (e) {
      logger.error(e, 'query error');
      try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
      await new QueryLog({ userId, query: queryText, results: 0, success: false }).save();
      await ctx.reply('❌ ' + tr(ctx, 'errors.searchError', 'Error occurred while searching. Please try again later.'));
    }
  }).catch(err => {
    logger.error(err, 'Error in query queue');
    ctx.reply('❌ An unexpected error occurred in the processing queue.');
  });
});

// ====== /lookup （HLR，成功才扣 1 点；使用封装的 *_E164 接口）======
async function guardRate(ctx) {
  // 可按需开启限流
  try {
    const userId = String(ctx.from.id);
    const rate = await checkAndConsume(userId);
    if (!rate.allowed) {
      await ctx.reply('请求过于频繁，请稍后再试（已达每分钟上限）。');
      return false;
    }
    return true;
  } catch {
    return true; // 限流模块异常时放行，避免中断业务
  }
}

bot.command('lookup', async (ctx) => {
  if (!await guardRate(ctx)) return;

  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  if (!user) return ctx.reply(tr(ctx, 'errors.notRegistered', '❌ You are not registered yet. Use /start first.'));

  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) return ctx.reply(tr(ctx, 'lookup.usage', 'Usage: /lookup <phone> (e.g. +60123456789 or 0123456789)'));

  const e164 = toE164(args[0]);
  if (!e164) return ctx.reply('❌ ' + tr(ctx, 'lookup.invalid', 'Invalid phone number. Please use a valid format.'));

  const waitMsg = await ctx.reply('📡 ' + tr(ctx, 'lookup.querying', 'Querying HLR, please wait...'));

  try {
    const r = await hlrLookupE164(e164); // <-- 使用封装（内部用 SDK + 单账户）
    const mp = r?.data?.mobile_phone || r?.data || r; // 兼容不同返回形态

    // 仅当查询成功才扣 1 点
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
    const add = (label, val) => lines.push(`<b>${htmlEsc(label)}:</b> ${htmlEsc(val ?? '')}`);

    add(tr(ctx, 'lookup.fields.msisdn', 'MSISDN'), mp?.msisdn || e164);
    add(tr(ctx, 'lookup.fields.status', 'Connectivity'), mp?.connectivity_status);
    add(tr(ctx, 'lookup.fields.mccmnc', 'MCCMNC'), mp?.mccmnc != null ? String(mp.mccmnc) : '');

    if (mp?.original_network) {
      add(tr(ctx, 'lookup.fields.original', 'Original Network'),
        `${mp.original_network.country_code || ''} ${mp.original_network.network_name || ''}`.trim());
    }
    if (mp?.ported_network) {
      add(tr(ctx, 'lookup.fields.current', 'Current Network'),
        `${mp.ported_network.country_code || ''} ${mp.ported_network.network_name || ''}`.trim());
    }
    if (mp?.roaming_network) {
      add(tr(ctx, 'lookup.fields.roaming', 'Roaming Network'),
        `${mp.roaming_network.country_code || ''} ${mp.roaming_network.network_name || ''}`.trim());
    }
    if (typeof mp?.is_ported === 'boolean') {
      add(tr(ctx, 'lookup.fields.ported', 'Ported'), mp.is_ported ? 'YES' : 'NO');
    }

    const body = `✅ ${tr(ctx, 'lookup.done', 'HLR lookup result')}:\n\n` + lines.join('\n');
    await ctx.reply(body, { parse_mode: 'HTML' });
    await new QueryLog({ userId, query: `[HLR] ${e164}`, results: 1, success: true }).save();
  } catch (err) {
    logger.error({ err }, 'HLR error');
    try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
    await new QueryLog({ userId, query: `[HLR] ${e164}`, results: 0, success: false }).save();
    await ctx.reply('❌ ' + tr(ctx, 'lookup.fail', 'HLR request failed. Please try again later.'));
  }
});

// ====== 文本直接转 /query ======
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return; // 已是命令
  ctx.message.text = `/query ${ctx.message.text}`;
  return bot.handleUpdate(ctx.update);
});

// ====== 充值：汇总入口（USDT / Stars）======
bot.action('recharge', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  let user = await User.findOne({ userId });
  if (!user) { user = new User({ userId, points: 0 }); await user.save(); }

  await ctx.reply(tr(ctx, 'recharge.choose', 'Choose a top-up method:'), Markup.inlineKeyboard([
    [Markup.button.callback('💫 Telegram Stars', 'recharge_stars')],
    [Markup.button.callback('💳 USDT-TRC20', 'recharge_usdt')],
  ]));
});

// ====== USDT 充值 ======
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

// ====== Stars 充值 ======
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
        provider_token: '',     // Stars 必须留空
        currency: 'XTR',        // Stars 货币
        prices: [{ label: `${pkg.points} ${tr(ctx,'points','points')}`, amount: pkg.stars }],
      });
    } catch (e) {
      logger.error({ e }, 'sendInvoice error');
      await ctx.reply('❌ ' + tr(ctx,'recharge.stars.fail','Failed to create Stars invoice.'));
    }
  });
}

bot.on('pre_checkout_query', async (ctx) => {
  try { await ctx.answerPreCheckoutQuery(true); } catch (e) { logger.error(e); }
});

bot.on('successful_payment', async (ctx) => {
  try {
    const sp = ctx.message.successful_payment;
    if (sp?.currency !== 'XTR') return;
    let payload = {};
    try { payload = JSON.parse(sp.invoice_payload || '{}'); } catch {}
    if (payload.kind !== 'stars_points') return;

    const points = Number(payload.points) || 0;
    const userId = ctx.from.id;

    if (points > 0) {
      await User.updateOne({ userId }, { $inc: { points } });
      await new QueryLog({
        userId,
        query: `[Stars] ${points}p / ${sp.total_amount} XTR`,
        results: 0,
        success: true
      }).save();

      await ctx.reply(`✅ ${tr(ctx,'recharge.stars.success','Payment received. Points added:')} <b>+${points}</b>`, { parse_mode: 'HTML' });
    }
  } catch (e) {
    logger.error(e, 'successful_payment handler error');
  }
});

// ====== 帮助/邀请/支持 ======
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
6️⃣ ${tr(ctx,'help.premium','Premium searches cost 50 points')}`;
  await ctx.reply(msg);
});

bot.action('invite', async (ctx) => {
  await ctx.answerCbQuery();
  const me = await bot.telegram.getMe();
  const inviteLink = `https://t.me/${me.username}?start=invite_${ctx.from.id}`;
  await ctx.reply(`👥 ${tr(ctx,'invite.text','Invite friends and earn 1 point per signup.')}
${tr(ctx,'invite.link','Your referral link:')}
${inviteLink}`);
});

bot.action('support', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('☎️ Contact support: @dbcheck');
});

// ====== 错误兜底 ======
bot.catch((err, ctx) => {
  logger.error({ err }, `❌ Error at update ${ctx.updateType}`);
});

// ====== Express / Webhook / 健康检查 ======
const app = express();
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;

// 仅在 webhook 模式下挂载回调
if (PUBLIC_URL) {
  app.use(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));
}

app.get('/', (req, res) => res.send('🤖 Bot is running!'));

// 可选：把定时充值扫描改为 Cloud Scheduler 调用这个路由
app.post('/cron/check-deposits', async (req, res) => {
  try { await checkDeposits(bot); res.status(200).send('ok'); }
  catch (e) { logger.error(e, 'checkDeposits error'); res.status(500).send('err'); }
});

// 本地轮询（可选，避免多副本重复）
let timer = null;
if (ENABLE_DEPOSIT_CRON) {
  timer = setInterval(() => checkDeposits(bot).catch(e => logger.error(e, 'checkDeposits tick error')), 30000);
  logger.info('Local deposit cron enabled (30s)');
}

app.listen(PORT, () => {
  logger.info({ port: PORT, mode: PUBLIC_URL ? 'webhook' : 'polling' }, 'HTTP server started');
  if (PUBLIC_URL) logger.info({ url: `${PUBLIC_URL}${WEBHOOK_PATH}` }, 'Webhook path');
});

// 优雅关停
process.once('SIGINT', () => {
  if (timer) clearInterval(timer);
  if (!PUBLIC_URL) bot.stop('SIGINT');
  mongoose.disconnect().finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  if (timer) clearInterval(timer);
  if (!PUBLIC_URL) bot.stop('SIGTERM');
  mongoose.disconnect().finally(() => process.exit(0));
});
