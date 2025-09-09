// index6.js
// (1) 可选加载 dotenv（未安装也不会报错）
try { require('dotenv').config(); } catch (_) {}

// (2) 依赖
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const randomUseragent = require('random-useragent');
const fs = require('fs').promises;
const path = require('path');

// (3) 启用 stealth
puppeteer.use(StealthPlugin());

// (4) 友好提示缺失的环境变量（不会中断）
['BOT_TOKEN','MONGODB_URI','SITE_USERNAME','SITE_PASSWORD'].forEach(k => {
  if (!process.env[k]) console.warn(`[WARN] Missing ${k}`);
});

// (5) 初始化 Telegram Bot
if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN is missing'); process.exit(1);
}
const bot = new Telegraf(process.env.BOT_TOKEN);

// (6) 连接 MongoDB
if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is missing'); process.exit(1);
}
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// (7) Mongoose 模型
const UserSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  points: { type: Number, default: 5 },
  invitedBy: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const QueryLogSchema = new mongoose.Schema({
  userId: Number,
  username: String,
  query: String,
  searchType: String,
  results: Number,
  resultsData: [{
    name: String,
    idCard: String,
    phone: String,
    address: String
  }],
  pointsDeducted: { type: Boolean, default: false },
  pointsAmount: { type: Number, default: 0 },
  success: Boolean,
  timestamp: { type: Date, default: Date.now }
});
const QueryLog = mongoose.model('QueryLog', QueryLogSchema);

// (8) 爬虫（Cookie 持久化 + 并发串行 + 表头自适应）
class ZownerCrawler {
  constructor() {
    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.loginAttempts = 0;
    this.maxLoginAttempts = 3;

    this.cookiesPath = path.resolve(process.cwd(), 'zowner_cookies.json');
    this.LOGIN_URL  = 'https://zowner.info/login.php';
    this.INDEX_URL  = 'https://zowner.info/index.php';
    this.RESULT_HINT= 'table';

    this.USERNAME = process.env.SITE_USERNAME || 'hayden';
    this.PASSWORD = process.env.SITE_PASSWORD || '123456';

    // 简单串行队列，避免并发时相互抢页面
    this._queueTail = Promise.resolve();
  }

  _enqueue(taskFn) {
    const prev = this._queueTail;
    let release;
    this._queueTail = new Promise(r => (release = r));
    return prev.then(async () => {
      try { return await taskFn(); }
      finally { release(); }
    });
  }

  async initBrowser() {
    if (this.browser) return;
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    this.page = await this.browser.newPage();
    const ua = randomUseragent.getRandom() || 'Mozilla/5.0';
    await this.page.setUserAgent(ua);
    await this.page.setViewport({ width: 1366, height: 768 });

    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    });

    await this._loadCookies();
    await this._checkSession();
  }

  async _loadCookies() {
    try {
      const exists = await fs.access(this.cookiesPath).then(() => true).catch(() => false);
      if (!exists) return;
      const cookies = JSON.parse(await fs.readFile(this.cookiesPath, 'utf8'));
      if (Array.isArray(cookies) && cookies.length) {
        await this.page.setCookie(...cookies);
      }
    } catch (_) {}
  }

  async _saveCookies() {
    try {
      const cookies = await this.page.cookies();
      await fs.writeFile(this.cookiesPath, JSON.stringify(cookies, null, 2), 'utf8');
    } catch (_) {}
  }

  async _checkSession() {
    try {
      await this.page.goto(this.INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const onLogin = /login\.php/i.test(this.page.url()) || (await this.page.$('input[name="myusername"]'));
      this.loggedIn = !onLogin;
    } catch {
      this.loggedIn = false;
    }
  }

  async login() {
    return this._enqueue(async () => {
      if (this.loggedIn) return true;
      await this.initBrowser();

      try {
        this.loginAttempts++;

        await this.page.goto(this.LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await this.page.waitForSelector('input[name="myusername"]', { timeout: 15000 });
        await this.page.waitForSelector('input[name="mypassword"]', { timeout: 15000 });

        await this.page.type('input[name="myusername"]', this.USERNAME, { delay: 20 });
        await this.page.type('input[name="mypassword"]', this.PASSWORD, { delay: 20 });

        await Promise.all([
          this.page.click('button.btn-login, input[type="submit"], button[type="submit"]'),
          this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
        ]);

        // 验证是否登录成功
        await this.page.goto(this.INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const stillLogin = /login\.php/i.test(this.page.url()) || (await this.page.$('input[name="myusername"]'));
        if (stillLogin) throw new Error('Login failed');

        this.loggedIn = true;
        this.loginAttempts = 0;
        await this._saveCookies();
        return true;
      } catch (error) {
        if (this.loginAttempts < this.maxLoginAttempts) {
          await this.close();
          return this.login();
        }
        throw new Error(`Too many login attempts: ${error.message}`);
      }
    });
  }

  _inferCategory(searchTerm) {
    const raw = String(searchTerm).trim();
    const digits = raw.replace(/\D/g, '');
    if (/[a-zA-Z\u4e00-\u9fa5]/.test(raw)) return 3;           // Name
    if (digits.length >= 10 && digits.length <= 12) return 4;  // Phone
    if (digits.length && digits.length <= 10) return 2;        // Old IC
    if (digits.length >= 11) return 1;                         // IC
    return 3;
  }

  async query(searchTerm) {
    return this._enqueue(async () => {
      try {
        if (!this.loggedIn) await this.login();

        await this.page.goto(this.INDEX_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        // 等待表单
        await this.page.waitForSelector('form.sform', { timeout: 15000 });
        await this.page.waitForSelector('input[name="keyword"]', { timeout: 15000 });

        // 输入关键词
        await this.page.evaluate(() => {
          const input = document.querySelector('input[name="keyword"]');
          if (input) input.value = '';
        });
        await this.page.type('input[name="keyword"]', String(searchTerm), { delay: 10 });

        // 选择分类
        const type = this._inferCategory(searchTerm);
        if (await this.page.$('select[name="category"]')) {
          await this.page.select('select[name="category"]', String(type));
          await this.page.evaluate(() => {
            const el = document.querySelector('select[name="category"]');
            if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
          });
        }

        // 点击 Buy Now（提交表单）
        await Promise.all([
          this.page.click('input#button.sbtn, input[type="submit"][value="Buy Now"], .sbtn'),
          this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
        ]);

        // 等结果表格
        await this.page.waitForSelector(this.RESULT_HINT, { timeout: 15000 }).catch(() => {});

        // 解析结果（表头映射）
        const results = await this.page.evaluate(() => {
          const pickTable = () => {
            const tables = Array.from(document.querySelectorAll('table'));
            return tables.find(t => t.querySelectorAll('tr').length > 1) || tables[0] || null;
          };
          const table = pickTable();
          if (!table) return [];

          const trs = Array.from(table.querySelectorAll('tr'));
          if (trs.length <= 1) return [];

          const headerCells = Array.from(trs[0].querySelectorAll('th,td')).map(th => th.textContent.trim().toLowerCase());
          const findIdx = (cands) => {
            const i = headerCells.findIndex(h => cands.some(k => h.includes(k)));
            return i >= 0 ? i : null;
          };

          const idxName  = findIdx(['name','姓名']);
          const idxIC    = findIdx(['ic','id','身份证']);
          const idxOldIC = findIdx(['old ic','旧','旧ic']);
          const idxAddr  = findIdx(['address','addr','住址','地址']);
          const idxPhone = findIdx(['phone','tel','电话','手机']);

          const items = [];
          const seen = new Set();

          for (let i = 1; i < trs.length; i++) {
            const tds = Array.from(trs[i].querySelectorAll('td')).map(td => td.textContent.trim());
            if (!tds.length) continue;

            const idCard = (idxIC!=null ? tds[idxIC] : (tds[0]||'')) || '';
            const name   = (idxName!=null ? tds[idxName] : (tds[1]||'')) || '';
            const oldIC  = (idxOldIC!=null ? tds[idxOldIC] : '') || '';
            const address= (idxAddr!=null ? tds[idxAddr] : (tds[3]||'')) || '';
            const phone  = (idxPhone!=null ? tds[idxPhone] : (tds[4]||'')) || '';

            const identifier = idCard || oldIC || (name + phone);
            if (identifier && !seen.has(identifier)) {
              seen.add(identifier);
              items.push({
                name: name || 'Unknown',
                idCard: idCard || oldIC || 'Unknown',
                phone: phone || 'Unknown',
                address: address || 'Unknown'
              });
            }
          }
          return items;
        });

        await this._saveCookies();
        return { results, searchType: 'auto' };
      } catch (error) {
        console.error('Query failed:', error.message);
        this.loggedIn = false;
        await this.login();
        return await this.query(searchTerm);
      }
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.loggedIn = false;
    }
  }
}

// (9) 单例
const crawler = new ZownerCrawler();

// (10) Bot 流程
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;

  let user = await User.findOne({ userId });
  if (!user) {
    const inviteMatch = (ctx.startPayload || '').match(/invite_(\d+)/);
    const invitedBy = inviteMatch ? parseInt(inviteMatch[1]) : null;

    user = new User({ userId, invitedBy });
    await user.save();

    if (invitedBy) {
      await User.findOneAndUpdate(
        { userId: invitedBy },
        { $inc: { points: 1 } }
      );
    }
  }

  await ctx.replyWithMarkdown(
`Welcome to WIKI LIEMO NEW BOT

Your ID: ${userId}  
Your current points: ${user.points}  

Quick Query:  
Simply send name/phone number/ID card number  

Combined Query:  
Use /query command with parameters in any combination  
/query Wang Weilin  
/query WangxLin x10x0x198x0x0xx34  
/query 110101198906046034 xxLin  
/query Zhang San 1373xxxxx55  

This bot will only display the following four fields in results: name, ID card number, phone number, and address. All other fields are filtered out and not displayed.  

Tutorial: https://telegra.ph/WIKI-LIEMO-NEW-BOT--HELP-08-20  
Support: @WikiLieMoSupport`,
    Markup.inlineKeyboard([
      [Markup.button.url('Tutorial', 'https://telegra.ph/WIKI-LIEMO-NEW-BOT--HELP-08-20')],
      [Markup.button.callback('Top Up Points', 'recharge'), Markup.button.callback('Help Guide', 'help')],
      [Markup.button.callback('Invite Friends', 'invite'), Markup.button.url('Official Channel', 'https://t.me/your_channel')]
    ])
  );
});

async function handleQuery(ctx, queryText) {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  const user = await User.findOne({ userId });
  if (!user || user.points <= 0) {
    return ctx.reply('Insufficient points, please top up before querying.');
  }

  // 简单校验
  const isChinese = /^[\u4e00-\u9fa5]+$/.test(queryText);
  const isIdLike  = /^[xX\d\-\s]{12,20}$/.test(queryText);
  const isPhoneLike = /^[xX\d\s]{10,12}$/.test(queryText);
  if (!(isChinese || isIdLike || isPhoneLike)) {
    return ctx.reply('Please enter a valid name, ID card number, or phone number to query.');
  }

  const waitMessage = await ctx.reply('Querying, please wait...');
  try {
    const { results, searchType } = await crawler.query(queryText);
    try { await ctx.deleteMessage(waitMessage.message_id); } catch (_) {}

    const hasResults = results.length > 0;

    await new QueryLog({
      userId,
      username,
      query: queryText,
      searchType,
      results: results.length,
      resultsData: results,
      pointsDeducted: hasResults,
      pointsAmount: hasResults ? 1 : 0,
      success: true
    }).save();

    if (!hasResults) {
      return ctx.reply('No matching results found. No points deducted.');
    }

    const formatted = results.map(item => (
`Name: ${item.name || 'N/A'}
ID Card: ${item.idCard || 'N/A'}
Phone: ${item.phone || 'N/A'}
Address: ${item.address || 'N/A'}
-------------------`
    )).join('\n');

    await User.findOneAndUpdate({ userId }, { $inc: { points: -1 } });
    const updatedUser = await User.findOne({ userId });

    return ctx.reply(
      `Found ${results.length} results:\n\n${formatted}\n\n1 point deducted. Remaining points: ${updatedUser.points}`
    );
  } catch (error) {
    try { await ctx.deleteMessage(waitMessage.message_id); } catch (_) {}
    await new QueryLog({
      userId,
      username,
      query: queryText,
      results: 0,
      success: false
    }).save();
    console.error('Query error:', error);
    return ctx.reply('An error occurred during query, please try again later.');
  }
}

// /query
bot.command('query', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) return ctx.reply('Please provide query parameters, e.g.: /query Wang Weilin');
  const queryText = args.join(' ');
  return handleQuery(ctx, queryText);
});

// 非命令文本
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  return handleQuery(ctx, ctx.message.text);
});

// 历史
bot.command('history', async (ctx) => {
  const userId = ctx.from.id;
  const queryLogs = await QueryLog.find({ userId }).sort({ timestamp: -1 }).limit(10);
  if (queryLogs.length === 0) return ctx.reply('No query history found.');

  const historyText = queryLogs.map((log, i) => (
`${i + 1}. Query: ${log.query}
   Results: ${log.results} | Type: ${log.searchType}
   Date: ${log.timestamp.toLocaleString()}
   Points: ${log.pointsDeducted ? `-${log.pointsAmount}` : '0'}`
  )).join('\n\n');

  await ctx.reply(`Your recent query history:\n\n${historyText}`);
});

// 回调
bot.action('recharge', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Please contact administrator @YourAdmin for points top-up.');
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(`Usage Guide:

1. Quick Query: Directly send name/ID card number/phone number
2. Combined Query: Use /query command followed by parameters
3. Each query consumes 1 point (only when results are found)
4. Invite friends to earn points rewards

For more details, please see the tutorial: https://telegra.ph/WIKI-LIEMO-NEW-BOT--HELP-08-20`);
});

bot.action('invite', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const inviteLink = `https://t.me/${ctx.botInfo.username}?start=invite_${userId}`;
  await ctx.reply(`Invite friends to use this bot, you will receive 1 point reward after they register. Your invitation link:\n${inviteLink}`);
});

// 错误处理
bot.catch((err, ctx) => {
  console.error(`Error handling update ${ctx.updateType}:`, err);
});

// 启动
bot.launch().then(() => {
  console.log('Bot started');
});

// 优雅退出
process.once('SIGINT', async () => { await crawler.close(); bot.stop('SIGINT'); });
process.once('SIGTERM', async () => { await crawler.close(); bot.stop('SIGTERM'); });

