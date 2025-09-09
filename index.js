const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const randomUseragent = require('random-useragent');

// 使用隐身插件避免被检测
puppeteer.use(StealthPlugin());

const BOT_TOKEN="7868225267:AAFJgqZ1l_XjoDOEZXExKAk2rdHqx6PQr10";
const MONGODB_URI="mongodb+srv://client2:5252Meimei@cluster0.bkbwpfb.mongodb.net/dbcheck";

// 初始化机器人
const bot = new Telegraf(BOT_TOKEN);

// 连接MongoDB
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// 用户模型
const UserSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  points: { type: Number, default: 5 },
  invitedBy: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// 查询日志模型
const QueryLogSchema = new mongoose.Schema({
  userId: Number,
  query: String,
  results: Number,
  success: Boolean,
  timestamp: { type: Date, default: Date.now }
});

const QueryLog = mongoose.model('QueryLog', QueryLogSchema);

// Zowner爬虫类
class ZownerCrawler {
  constructor() {
    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.loginAttempts = 0;
    this.maxLoginAttempts = 3;
  }

  // 初始化浏览器
  async initBrowser() {
    if (this.browser) {
      return;
    }

    try {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });

      // 创建新页面
      this.page = await this.browser.newPage();
      
      // 设置随机用户代理
      const ua = randomUseragent.getRandom();
      await this.page.setUserAgent(ua);
      
      // 设置视口大小
      await this.page.setViewport({ width: 1366, height: 768 });
      
      // 绕过自动化检测
      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
        });
      });
      
      await this.page.evaluateOnNewDocument(() => {
        window.chrome = {
          runtime: {},
        };
      });
      
      await this.page.evaluateOnNewDocument(() => {
        const originalQuery = window.navigator.permissions.query;
        return window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );
      });
    } catch (error) {
      console.error('初始化浏览器失败:', error);
      throw error;
    }
  }

  // 登录到zowner.info
  async login() {
    if (this.loggedIn) {
      return true;
    }

    await this.initBrowser();
    
    try {
      console.log('正在登录zowner.info...');
      
      // 导航到登录页面
      await this.page.goto('https://zowner.info/login', { 
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      
      // 等待登录表单加载
      await this.page.waitForSelector('input[name="username"]', { timeout: 10000 });
      await this.page.waitForSelector('input[name="password"]', { timeout: 10000 });
      
      // 输入用户名和密码
      await this.page.type('input[name="username"]', 'hayden');
      await this.page.type('input[name="password"]', '123456');
      
      // 点击登录按钮
      await this.page.click('button[type="submit"]');
      
      // 等待导航完成
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
      
      // 检查是否登录成功
      const currentUrl = this.page.url();
      if (!currentUrl.includes('login')) {
        this.loggedIn = true;
        this.loginAttempts = 0;
        console.log('登录zowner.info成功');
        return true;
      } else {
        throw new Error('登录失败，可能用户名或密码错误');
      }
    } catch (error) {
      this.loginAttempts++;
      console.error('登录失败:', error.message);
      
      if (this.loginAttempts >= this.maxLoginAttempts) {
        await this.close();
        throw new Error(`登录失败次数过多: ${error.message}`);
      }
      
      // 重试登录
      await this.close();
      await this.initBrowser();
      return await this.login();
    }
  }

  // 执行查询
  async query(searchTerm) {
    try {
      // 确保已登录
      if (!this.loggedIn) {
        await this.login();
      }
      
      console.log(`正在查询: ${searchTerm}`);
      
      // 导航到搜索页面
      await this.page.goto('https://zowner.info/search', { 
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      
      // 等待搜索框加载
      await this.page.waitForSelector('input[type="search"]', { timeout: 10000 });
      
      // 清空搜索框并输入查询词
      await this.page.evaluate(() => {
        const searchInput = document.querySelector('input[type="search"]');
        searchInput.value = '';
      });
      
      await this.page.type('input[type="search"]', searchTerm);
      
      // 点击搜索按钮
      await this.page.click('button[type="submit"]');
      
      // 等待结果加载
      await this.page.waitForSelector('.result-item, .no-results, table tr', { timeout: 15000 });
      
      // 获取搜索结果
      const results = await this.page.evaluate(() => {
        const items = [];
        
        // 尝试多种选择器以适应不同的页面结构
        const selectors = [
          '.result-item',
          'table tr',
          '.data-row',
          '.item'
        ];
        
        let elements = [];
        for (const selector of selectors) {
          elements = document.querySelectorAll(selector);
          if (elements.length > 0) break;
        }
        
        // 如果没有找到结果
        if (elements.length === 0) {
          const noResults = document.querySelector('.no-results, .no-data');
          if (noResults) {
            return [];
          }
        }
        
        // 处理表格行
        elements.forEach((element, index) => {
          // 跳过表头
          if (index === 0 && element.querySelector('th')) {
            return;
          }
          
          const text = element.innerText.trim();
          if (text) {
            // 尝试解析不同的数据格式
            const lines = text.split('\n').filter(line => line.trim());
            
            if (lines.length >= 4) {
              // 假设格式为: 姓名, 身份证, 手机号, 地址
              const item = {
                name: lines[0].trim(),
                idCard: lines[1].trim(),
                phone: lines[2].trim(),
                address: lines[3].trim()
              };
              items.push(item);
            } else if (text.includes('姓名') || text.includes('身份证') || text.includes('手机')) {
              // 尝试从文本中提取信息
              const nameMatch = text.match(/姓名[：:]\s*([^\s]+)/);
              const idCardMatch = text.match(/身份证[：:]\s*([^\s]+)/);
              const phoneMatch = text.match(/手机[：:]\s*([^\s]+)/);
              const addressMatch = text.match(/地址[：:]\s*([^\n]+)/);
              
              const item = {
                name: nameMatch ? nameMatch[1] : '未知',
                idCard: idCardMatch ? idCardMatch[1] : '未知',
                phone: phoneMatch ? phoneMatch[1] : '未知',
                address: addressMatch ? addressMatch[1] : '未知'
              };
              items.push(item);
            }
          }
        });
        
        return items;
      });
      
      console.log(`找到 ${results.length} 条结果`);
      return results;
    } catch (error) {
      console.error('查询失败:', error.message);
      
      // 如果查询失败，尝试重新登录后再次查询
      this.loggedIn = false;
      await this.login();
      return await this.query(searchTerm);
    }
  }

  // 关闭浏览器
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.loggedIn = false;
    }
  }
}

// 创建爬虫实例
const crawler = new ZownerCrawler();

// 启动命令
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  
  // 检查用户是否存在
  let user = await User.findOne({ userId });
  
  if (!user) {
    // 检查是否有邀请参数
    const inviteMatch = ctx.startPayload.match(/invite_(\d+)/);
    const invitedBy = inviteMatch ? parseInt(inviteMatch[1]) : null;
    
    // 创建新用户
    user = new User({ userId, invitedBy });
    await user.save();
    
    // 给邀请人奖励
    if (invitedBy) {
      await User.findOneAndUpdate(
        { userId: invitedBy },
        { $inc: { points: 1 } }
      );
    }
  }
  
  // 发送欢迎消息
await ctx.replyWithMarkdown(`Welcome to DBCHECK

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
`,
    Markup.inlineKeyboard([
      [Markup.button.url('Tutorial', 'https://telegra.ph/dbcheck')],
      [Markup.button.callback('Top Up Points', 'recharge'), Markup.button.callback('Help Guide', 'help')],
      [Markup.button.callback('Invite Friends', 'invite'), Markup.button.url('Official Channel', 'https://t.me/your_channel')]
    ])
  );
});



// 查询命令
bot.command('query', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  
  if (!user || user.points <= 0) {
    return ctx.reply('您的积分不足，请充值后再查询。');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('请提供查询参数，例如: /query 王维林');
  }
  
  const queryText = args.join(' ');
  
  // 发送等待消息
  const waitMessage = await ctx.reply('正在查询中，请稍候...');
  
  try {
    // 使用爬虫查询
    const results = await crawler.query(queryText);
    
    // 删除等待消息
    await ctx.deleteMessage(waitMessage.message_id);
    
    // 记录查询日志
    await new QueryLog({
      userId,
      query: queryText,
      results: results.length,
      success: true
    }).save();
    
    if (results.length === 0) {
      await ctx.reply('未找到匹配的结果。');
    } else {
      // 格式化结果，只显示指定字段
      const formattedResults = results.map(item => {
        return `姓名: ${item.name || '无'}
身份证: ${item.idCard || '无'}
手机号: ${item.phone || '无'}
地址: ${item.address || '无'}\n-------------------`;
      }).join('\n');
      
      await ctx.reply(`找到 ${results.length} 条结果:\n\n${formattedResults}`);
      
      // 扣除积分
      await User.findOneAndUpdate(
        { userId },
        { $inc: { points: -1 } }
      );
    }
  } catch (error) {
    // 删除等待消息
    try {
      await ctx.deleteMessage(waitMessage.message_id);
    } catch (e) {}
    
    // 记录错误日志
    await new QueryLog({
      userId,
      query: queryText,
      results: 0,
      success: false
    }).save();
    
    console.error('查询错误:', error);
    await ctx.reply('查询过程中出现错误，请稍后再试。');
  }
});

// 处理直接发送的查询
bot.on('text', async (ctx) => {
  // 忽略命令
  if (ctx.message.text.startsWith('/')) return;
  
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });
  
  if (!user || user.points <= 0) {
    return ctx.reply('您的积分不足，请充值后再查询。');
  }
  
  const queryText = ctx.message.text;
  
  // 验证查询参数
  let isValidQuery = false;
  
  // 检查是否是中文姓名
  if (/^[\u4e00-\u9fa5]+$/.test(queryText)) {
    isValidQuery = true;
  }
  // 检查是否是身份证号（支持模糊匹配）
  else if (/^[xX\d]{17,18}$/.test(queryText.replace(/\s/g, ''))) {
    isValidQuery = true;
  }
  // 检查是否是手机号（支持模糊匹配）
  else if (/^[xX\d]{11}$/.test(queryText.replace(/\s/g, ''))) {
    isValidQuery = true;
  }
  
  if (!isValidQuery) {
    return ctx.reply('请输入有效的姓名、身份证号或手机号进行查询。');
  }
  
  // 发送等待消息
  const waitMessage = await ctx.reply('正在查询中，请稍候...');
  
  try {
    // 使用爬虫查询
    const results = await crawler.query(queryText);
    
    // 删除等待消息
    await ctx.deleteMessage(waitMessage.message_id);
    
    // 记录查询日志
    await new QueryLog({
      userId,
      query: queryText,
      results: results.length,
      success: true
    }).save();
    
    if (results.length === 0) {
      await ctx.reply('未找到匹配的结果。');
    } else {
      // 格式化结果，只显示指定字段
      const formattedResults = results.map(item => {
        return `姓名: ${item.name || '无'}
身份证: ${item.idCard || '无'}
手机号: ${item.phone || '无'}
地址: ${item.address || '无'}\n-------------------`;
      }).join('\n');
      
      await ctx.reply(`找到 ${results.length} 条结果:\n\n${formattedResults}`);
      
      // 扣除积分
      await User.findOneAndUpdate(
        { userId },
        { $inc: { points: -1 } }
      );
    }
  } catch (error) {
    // 删除等待消息
    try {
      await ctx.deleteMessage(waitMessage.message_id);
    } catch (e) {}
    
    // 记录错误日志
    await new QueryLog({
      userId,
      query: queryText,
      results: 0,
      success: false
    }).save();
    
    console.error('查询错误:', error);
    await ctx.reply('查询过程中出现错误，请稍后再试。');
  }
});

// 充值回调
bot.action('recharge', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('请联系管理员 @YourAdmin 进行积分充值。');
});

// 帮助回调
bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(`使用帮助:

1. 快速查询: 直接发送姓名、身份证号或手机号
2. 组合查询: 使用 /query 命令后跟查询参数
3. 每条查询消耗1点积分
4. 邀请好友可获得积分奖励

更多详情请查看使用教程: https://telegra.ph/WIKI-LIEMO-NEW-BOT--HELP-08-20`);
});

// 邀请回调
bot.action('invite', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const inviteLink = `https://t.me/${ctx.botInfo.username}?start=invite_${userId}`;
  await ctx.reply(`邀请好友使用本机器人，好友注册后您将获得1点积分奖励。您的邀请链接:\n${inviteLink}`);
});

// 错误处理
bot.catch((err, ctx) => {
  console.error(`错误处理更新 ${ctx.updateType}:`, err);
});

// 启动机器人
bot.launch().then(() => {
  console.log('机器人已启动');
});

// 优雅关闭
process.once('SIGINT', async () => {
  await crawler.close();
  bot.stop('SIGINT');
});

process.once('SIGTERM', async () => {
  await crawler.close();
  bot.stop('SIGTERM');
});
