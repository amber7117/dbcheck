const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const randomUseragent = require('random-useragent');
const fs = require('fs').promises;
const path = require('path');

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

// Cookie storage path
const COOKIE_PATH = path.join(__dirname, 'zowner_cookies.json');

// Zowner crawler class
class ZownerCrawler {
  constructor() {
    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.loginAttempts = 0;
    this.maxLoginAttempts = 3;
    this.cookies = null;
    this.lastLoginTime = null;
    this.cookieValidity = 30 * 60 * 1000; // 30 minutes cookie validity
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

  // Load cookies from file
  async loadCookies() {
    try {
      const data = await fs.readFile(COOKIE_PATH, 'utf8');
      const cookieData = JSON.parse(data);
      
      // Check if cookies are still valid
      if (Date.now() - cookieData.timestamp < this.cookieValidity) {
        this.cookies = cookieData.cookies;
        this.lastLoginTime = cookieData.timestamp;
        console.log('Cookies loaded successfully');
        return true;
      } else {
        console.log('Cookies expired');
        return false;
      }
    } catch (error) {
      console.log('No valid cookies found');
      return false;
    }
  }

  // Save cookies to file
  async saveCookies(cookies) {
    try {
      const cookieData = {
        cookies: cookies,
        timestamp: Date.now()
      };
      await fs.writeFile(COOKIE_PATH, JSON.stringify(cookieData, null, 2));
      console.log('Cookies saved successfully');
    } catch (error) {
      console.error('Failed to save cookies:', error);
    }
  }

  // Set cookies to page
  async setCookies() {
    if (this.cookies && this.page) {
      await this.page.setCookie(...this.cookies);
      console.log('Cookies set to page');
    }
  }

  // Check if we're logged in by visiting index page
  async checkLoginStatus() {
    try {
      await this.page.goto('https://zowner.info/index.php', {
        waitUntil: 'networkidle2',
        timeout: 10000
      });

      // Check if we're on the index page (logged in) and search form is present
      const currentUrl = this.page.url();
      if (currentUrl.includes('index.php') || !currentUrl.includes('login')) {
        // Check if search form is present (indicates successful login)
        const searchForm = await this.page.$('input[name="keyword"]');
        if (searchForm) {
          console.log('Already logged in with valid cookies');
          this.loggedIn = true;
          return true;
        }
      }
      
      return false;
    } catch (error) {
      console.log('Login status check failed:', error.message);
      return false;
    }
  }

  // Login to zowner.info
  async login() {
    // Check if we have valid cookies and can reuse them
    const hasValidCookies = await this.loadCookies();
    if (hasValidCookies) {
      await this.initBrowser();
      await this.setCookies();
      
      // Check if cookies are still valid
      if (await this.checkLoginStatus()) {
        this.loggedIn = true;
        return true;
      }
    }

    // If no valid cookies or cookies expired, do fresh login
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
      
      // Check if login was successful - should be redirected to index.php
      const currentUrl = this.page.url();
      if (currentUrl.includes('index.php') || !currentUrl.includes('login')) {
        // Check if search form is present to confirm successful login
        const searchForm = await this.page.$('input[name="keyword"]');
        if (searchForm) {
          // Save cookies for future use
          const cookies = await this.page.cookies();
          await this.saveCookies(cookies);
          this.cookies = cookies;
          this.lastLoginTime = Date.now();
          
          this.loggedIn = true;
          this.loginAttempts = 0;
          console.log('Successfully logged in to zowner.info and saved cookies');
          return true;
        }
      }
      
      // If we reach here, login failed
      const errorMsg = await this.page.evaluate(() => {
        const errorElement = document.querySelector('.error-message, .alert-danger');
        return errorElement ? errorElement.textContent.trim() : 'Login failed - unknown reason';
      });
      
      throw new Error(errorMsg);
      
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
      
      // Navigate to homepage (index.php) where search form is located
      await this.page.goto('https://zowner.info/index.php', { 
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      
      // Wait for search form to load
      await this.page.waitForSelector('input[name="keyword"]', { timeout: 10000 });
      
      // Clear search field and enter query
      await this.page.evaluate(() => {
        const searchInput = document.querySelector('input[name="keyword"]');
        if (searchInput) {
          searchInput.value = '';
          searchInput.style.color = '#000000'; // Ensure text color is black
        }
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
      
      // Click "Buy Now" button to submit search
      await Promise.all([
        this.page.click('input[type="submit"][value="Buy Now"]'),
        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
      ]);
      
      // Wait for results to load (should be on list.php now)
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
      
      // If query fails, cookies might be expired, try to login again
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

// ... rest of the bot code remains the same as previous version ...

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
