const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const randomUseragent = require('random-useragent');

// Use stealth plugin to avoid detection
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


// User model
const UserSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  points: { type: Number, default: 5 },
  invitedBy: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// Query log model
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

// Zowner crawler class
class ZownerCrawler {
  constructor() {
    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.loginAttempts = 0;
    this.maxLoginAttempts = 3;
  }

  // Initialize browser
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

      // Create new page
      this.page = await this.browser.newPage();
      
      // Set random user agent
      const ua = randomUseragent.getRandom();
      await this.page.setUserAgent(ua);
      
      // Set viewport size
      await this.page.setViewport({ width: 1366, height: 768 });
      
      // Bypass automation detection
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
      console.error('Browser initialization failed:', error);
      throw error;
    }
  }

  // Login to zowner.info
  async login() {
    if (this.loggedIn) {
      return true;
    }

    await this.initBrowser();
    
    try {
      console.log('Logging in to zowner.info...');
      
      // Navigate to login page
      await this.page.goto('https://zowner.info/login.php', { 
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      
      // Wait for login form to load
      await this.page.waitForSelector('input[name="myusername"]', { timeout: 10000 });
      await this.page.waitForSelector('input[name="mypassword"]', { timeout: 10000 });
      
      // Enter username and password
      await this.page.type('input[name="myusername"]', 'hayden');
      await this.page.type('input[name="mypassword"]', '123456');
      
      // Click login button
      await Promise.all([
        this.page.click('button.btn-login'),
        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
      ]);
      
      // Check if login was successful
      const currentUrl = this.page.url();
      if (!currentUrl.includes('login')) {
        this.loggedIn = true;
        this.loginAttempts = 0;
        console.log('Successfully logged in to zowner.info');
        return true;
      } else {
        // Check for error message
        const errorMsg = await this.page.evaluate(() => {
          const errorElement = document.querySelector('.error-message, .alert-danger');
          return errorElement ? errorElement.textContent.trim() : null;
        });
        
        throw new Error(errorMsg || 'Login failed, possibly wrong username or password');
      }
    } catch (error) {
      this.loginAttempts++;
      console.error('Login failed:', error.message);
      
      if (this.loginAttempts >= this.maxLoginAttempts) {
        await this.close();
        throw new Error(`Too many login attempts: ${error.message}`);
      }
      
      // Retry login
      await this.close();
      await this.initBrowser();
      return await this.login();
    }
  }

  // Execute query
  async query(searchTerm) {
    try {
      // Ensure logged in
      if (!this.loggedIn) {
        await this.login();
      }
      
      console.log(`Querying: ${searchTerm}`);
      
      // Navigate to homepage
      await this.page.goto('https://zowner.info/index.php', { 
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      
      // Wait for search form to load
      await this.page.waitForSelector('input[name="keyword"]', { timeout: 10000 });
      
      // Clear search field and enter query
      await this.page.evaluate(() => {
        const searchInput = document.querySelector('input[name="keyword"]');
        if (searchInput) searchInput.value = '';
      });
      
      // Enter search term
      await this.page.type('input[name="keyword"]', searchTerm);
      
      // Determine search type based on input
      let searchType = 'name'; // Default: search by name
      let searchCategory = 3; // Default category for name search
      
      // If input contains only numbers, search by phone
      if (/^\d+$/.test(searchTerm.replace(/\D/g, ''))) {
        searchType = 'phone';
        searchCategory = 4; // Search by phone
      }
      // If input contains letters, search by name
      else if (/[a-zA-Z]/.test(searchTerm)) {
        searchType = 'name';
        searchCategory = 3; // Search by name
      }
      
      // Set search category
      await this.page.evaluate((type) => {
        const select = document.querySelector('select[name="category"]');
        if (select) {
          select.value = type;
        }
      }, searchCategory);
      
      // Click search button
      await Promise.all([
        this.page.click('input[type="submit"]'),
        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
      ]);
      
      // Wait for results to load
      await this.page.waitForSelector('#dataTable tbody tr, .no-results', { timeout: 15000 });
      
      // Get search results
      const results = await this.page.evaluate(() => {
        const items = [];
        const seenIds = new Set(); // For deduplication
        
        // Get all result rows
        const rows = document.querySelectorAll('#dataTable tbody tr');
        
        // If no results found
        if (rows.length === 0) {
          const noResults = document.querySelector('.no-results, .no-data');
          if (noResults) {
            return [];
          }
        }
        
        // Process each row of data
        rows.forEach((row) => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 5) {
            // Extract data
            const idCard = cells[0].textContent.trim();
            const name = cells[1].textContent.trim();
            const oldIdCard = cells[2].textContent.trim();
            const address = cells[3].textContent.trim();
            const phone = cells[4].textContent.trim();
            
            // Use ID card number for deduplication
            const identifier = idCard || oldIdCard || name + phone;
            
            if (!seenIds.has(identifier)) {
              seenIds.add(identifier);
              
              const item = {
                name: name || 'Unknown',
                idCard: idCard || oldIdCard || 'Unknown',
                phone: phone || 'Unknown',
                address: address || 'Unknown'
              };
              
              items.push(item);
            }
          }
        });
        
        return items;
      });
      
      console.log(`Found ${results.length} results`);
      return {
        results,
        searchType
      };
    } catch (error) {
      console.error('Query failed:', error.message);
      
      // If query fails, try to login again and retry
      this.loggedIn = false;
      await this.login();
      return await this.query(searchTerm);
    }
  }

  // Close browser
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.loggedIn = false;
    }
  }
}

// Create crawler instance
const crawler = new ZownerCrawler();

// Start command
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  
  // Check if user exists
  let user = await User.findOne({ userId });
  
  if (!user) {
    // Check for invite parameter
    const inviteMatch = ctx.startPayload.match(/invite_(\d+)/);
    const invitedBy = inviteMatch ? parseInt(inviteMatch[1]) : null;
    
    // Create new user
    user = new User({ userId, invitedBy });
    await user.save();
    
    // Reward inviter
    if (invitedBy) {
      await User.findOneAndUpdate(
        { userId: invitedBy },
        { $inc: { points: 1 } }
      );
    }
  }
  
  // Send welcome message
  await ctx.replyWithMarkdown(`Welcome to WIKI LIEMO NEW BOT

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

// Query command
bot.command('query', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  const user = await User.findOne({ userId });
  
  if (!user || user.points <= 0) {
    return ctx.reply('Insufficient points, please top up before querying.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('Please provide query parameters, e.g.: /query Wang Weilin');
  }
  
  const queryText = args.join(' ');
  
  // Send waiting message
  const waitMessage = await ctx.reply('Querying, please wait...');
  
  try {
    // Use crawler to query
    const { results, searchType } = await crawler.query(queryText);
    
    // Delete waiting message
    await ctx.deleteMessage(waitMessage.message_id);
    
    // Check if results were found
    const hasResults = results.length > 0;
    
    // Log query with detailed information
    const queryLog = new QueryLog({
      userId,
      username,
      query: queryText,
      searchType,
      results: results.length,
      resultsData: results,
      pointsDeducted: hasResults,
      pointsAmount: hasResults ? 1 : 0,
      success: true
    });
    
    await queryLog.save();
    
    if (!hasResults) {
      await ctx.reply('No matching results found. No points deducted.');
    } else {
      // Format results, only show specified fields
      const formattedResults = results.map(item => {
        return `Name: ${item.name || 'N/A'}
ID Card: ${item.idCard || 'N/A'}
Phone: ${item.phone || 'N/A'}
Address: ${item.address || 'N/A'}\n-------------------`;
      }).join('\n');
      
      // Deduct points only if results were found
      if (hasResults) {
        await User.findOneAndUpdate(
          { userId },
          { $inc: { points: -1 } }
        );
        
        // Get updated points
        const updatedUser = await User.findOne({ userId });
        
        await ctx.reply(`Found ${results.length} results:\n\n${formattedResults}\n\n1 point deducted. Remaining points: ${updatedUser.points}`);
      } else {
        await ctx.reply(`Found ${results.length} results:\n\n${formattedResults}`);
      }
    }
  } catch (error) {
    // Delete waiting message
    try {
      await ctx.deleteMessage(waitMessage.message_id);
    } catch (e) {}
    
    // Log error
    await new QueryLog({
      userId,
      username: ctx.from.username || ctx.from.first_name,
      query: queryText,
      results: 0,
      success: false
    }).save();
    
    console.error('Query error:', error);
    await ctx.reply('An error occurred during query, please try again later.');
  }
});

// Handle direct queries
bot.on('text', async (ctx) => {
  // Ignore commands
  if (ctx.message.text.startsWith('/')) return;
  
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  const user = await User.findOne({ userId });
  
  if (!user || user.points <= 0) {
    return ctx.reply('Insufficient points, please top up before querying.');
  }
  
  const queryText = ctx.message.text;
  
  // Validate query parameters
  let isValidQuery = false;
  
  // Check if it's Chinese name
  if (/^[\u4e00-\u9fa5]+$/.test(queryText)) {
    isValidQuery = true;
  }
  // Check if it's ID card number (supports fuzzy matching)
  else if (/^[xX\d\-\s]{12,20}$/.test(queryText)) {
    isValidQuery = true;
  }
  // Check if it's phone number (supports fuzzy matching)
  else if (/^[xX\d\s]{10,12}$/.test(queryText)) {
    isValidQuery = true;
  }
  
  if (!isValidQuery) {
    return ctx.reply('Please enter a valid name, ID card number, or phone number to query.');
  }
  
  // Send waiting message
  const waitMessage = await ctx.reply('Querying, please wait...');
  
  try {
    // Use crawler to query
    const { results, searchType } = await crawler.query(queryText);
    
    // Delete waiting message
    await ctx.deleteMessage(waitMessage.message_id);
    
    // Check if results were found
    const hasResults = results.length > 0;
    
    // Log query with detailed information
    const queryLog = new QueryLog({
      userId,
      username,
      query: queryText,
      searchType,
      results: results.length,
      resultsData: results,
      pointsDeducted: hasResults,
      pointsAmount: hasResults ? 1 : 0,
      success: true
    });
    
    await queryLog.save();
    
    if (!hasResults) {
      await ctx.reply('No matching results found. No points deducted.');
    } else {
      // Format results, only show specified fields
      const formattedResults = results.map(item => {
        return `Name: ${item.name || 'N/A'}
ID Card: ${item.idCard || 'N/A'}
Phone: ${item.phone || 'N/A'}
Address: ${item.address || 'N/A'}\n-------------------`;
      }).join('\n');
      
      // Deduct points only if results were found
      if (hasResults) {
        await User.findOneAndUpdate(
          { userId },
          { $inc: { points: -1 } }
        );
        
        // Get updated points
        const updatedUser = await User.findOne({ userId });
        
        await ctx.reply(`Found ${results.length} results:\n\n${formattedResults}\n\n1 point deducted. Remaining points: ${updatedUser.points}`);
      } else {
        await ctx.reply(`Found ${results.length} results:\n\n${formattedResults}`);
      }
    }
  } catch (error) {
    // Delete waiting message
    try {
      await ctx.deleteMessage(waitMessage.message_id);
    } catch (e) {}
    
    // Log error
    await new QueryLog({
      userId,
      username: ctx.from.username || ctx.from.first_name,
      query: queryText,
      results: 0,
      success: false
    }).save();
    
    console.error('Query error:', error);
    await ctx.reply('An error occurred during query, please try again later.');
  }
});

// Add command to check query history
bot.command('history', async (ctx) => {
  const userId = ctx.from.id;
  
  const queryLogs = await QueryLog.find({ userId })
    .sort({ timestamp: -1 })
    .limit(10);
  
  if (queryLogs.length === 0) {
    return ctx.reply('No query history found.');
  }
  
  const historyText = queryLogs.map((log, index) => {
    return `${index + 1}. Query: ${log.query}
   Results: ${log.results} | Type: ${log.searchType}
   Date: ${log.timestamp.toLocaleString()}
   Points: ${log.pointsDeducted ? `-${log.pointsAmount}` : '0'}\n`;
  }).join('\n');
  
  await ctx.reply(`Your recent query history:\n\n${historyText}`);
});

// Top up callback
bot.action('recharge', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Please contact administrator @YourAdmin for points top-up.');
});

// Help callback
bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(`Usage Guide:

1. Quick Query: Directly send name/ID card number/phone number
2. Combined Query: Use /query command followed by parameters
3. Each query consumes 1 point (only when results are found)
4. Invite friends to earn points rewards

For more details, please see the tutorial: https://telegra.ph/WIKI-LIEMO-NEW-BOT--HELP-08-20`);
});

// Invite callback
bot.action('invite', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const inviteLink = `https://t.me/${ctx.botInfo.username}?start=invite_${userId}`;
  await ctx.reply(`Invite friends to use this bot, you will receive 1 point reward after they register. Your invitation link:\n${inviteLink}`);
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`Error handling update ${ctx.updateType}:`, err);
});

// Start bot
bot.launch().then(() => {
  console.log('Bot started');
});

// Graceful shutdown
process.once('SIGINT', async () => {
  await crawler.close();
  bot.stop('SIGINT');
});

process.once('SIGTERM', async () => {
  await crawler.close();
  bot.stop('SIGTERM');
});
