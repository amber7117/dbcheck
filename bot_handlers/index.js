const { Markup } = require('telegraf');
const User = require('../models/user');
const QueryLog = require('../models/queryLog');
const search = require('../crawler/search');
const { lookup } = require('../hlrlookup');

function getLocale(locales, languageCode) {
  return locales[languageCode] || locales['en'];
}

function register(bot, locales) {
  bot.start(async (ctx) => {
    const userId = ctx.from.id;
    let user = await User.findOne({ userId });

    if (!user) {
      const inviteMatch = ctx.startPayload?.match(/invite_(\d+)/);
      const invitedBy = inviteMatch ? parseInt(inviteMatch[1]) : null;

      user = new User({ userId, invitedBy, points: 5 }); // Give 5 points to new users
      await user.save();

      if (invitedBy) {
        await User.findOneAndUpdate(
          { userId: invitedBy },
          { $inc: { points: 1 } }
        );
      }
    }

    const lang = getLocale(locales, ctx.from.language_code);
    await ctx.replyWithMarkdown(
      lang.welcome.replace('{userId}', userId).replace('{points}', user.points),
      Markup.inlineKeyboard([
        [Markup.button.callback('💎 Advance Search', 'premium')],
        [Markup.button.callback('💳 Top Up', 'recharge'), Markup.button.callback('❓ Help', 'help')],
        [Markup.button.callback('👥 Invite', 'invite'), Markup.button.callback('☎️ Support', 'support')]
      ])
    );
  });

  bot.action('premium', async (ctx) => {
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });
    const lang = getLocale(locales, ctx.from.language_code);
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

  bot.action('confirm_premium', async (ctx) => {
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });
    const lang = getLocale(locales, ctx.from.language_code);
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
    const lang = getLocale(locales, ctx.from.language_code);

    await ctx.replyWithMarkdown(
      lang.premium_search_cancelled.replace('{userId}', userId).replace('{points}', user.points),
      Markup.inlineKeyboard([
        [Markup.button.callback('💎 Advance Search', 'premium')],
        [Markup.button.callback('💳 Top Up', 'recharge'), Markup.button.callback('❓ Help', 'help')],
        [Markup.button.callback('👥 Invite', 'invite'), Markup.button.callback('☎️ Support', 'support')]
      ])
    );
  });

  bot.command('balance', async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    const lang = getLocale(locales, ctx.from.language_code);
    if (!user) return ctx.reply(lang.not_registered);
    return ctx.reply(lang.balance_message.replace('{points}', user.points), { parse_mode: 'Markdown' });
  });

  bot.command('lookup', async (ctx) => {
    const lang = getLocale(locales, ctx.from.language_code);
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

  bot.command('query', async (ctx) => {
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });
    const lang = getLocale(locales, ctx.from.language_code);
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

  bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    ctx.message.text = `/query ${ctx.message.text}`;
    return bot.handleUpdate(ctx.update);
  });

  bot.action('recharge', async (ctx) => {
    await ctx.answerCbQuery();
    const lang = getLocale(locales, ctx.from.language_code);
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
    const lang = getLocale(locales, ctx.from.language_code);

    // Here you would integrate with Telegram's payment API
    // For now, we'll just simulate a successful payment
    const userId = ctx.from.id;
    await User.findOneAndUpdate({ userId }, { $inc: { points: amount } });

    await ctx.answerCbQuery();
    await ctx.reply(lang.payment_successful);
  });

  bot.action('help', async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    const lang = getLocale(locales, ctx.from.language_code);
    await ctx.answerCbQuery();
    await ctx.replyWithMarkdown(lang.help_message.replace('{points}', user?.points || 0));
  });

  bot.action('invite', async (ctx) => {
    await ctx.answerCbQuery();
    const inviteLink = `https://t.me/${bot.botInfo.username}?start=invite_${ctx.from.id}`;
    const lang = getLocale(locales, ctx.from.language_code);
    await ctx.reply(lang.invite_message.replace('{inviteLink}', inviteLink));
  });

  bot.action('support', async (ctx) => {
    await ctx.answerCbQuery();
    const lang = getLocale(locales, ctx.from.language_code);
    await ctx.reply(lang.support_message);
  });
}

module.exports = {
  register
};
