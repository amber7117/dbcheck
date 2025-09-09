const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// cookies.json 统一放在项目根目录
const cookiePath = path.join(__dirname, '..', 'cookies.json');

async function search(queryText) {
  // 检查 cookie 文件
  if (!fs.existsSync(cookiePath)) {
    throw new Error('请先运行 login.js 登录保存 cookies');
  }

  // 读取 cookies
  const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();

  // 设置 cookies
  await page.setCookie(...cookies);

  // 打开搜索页面
  await page.goto('https://zowner.info/index.php', { waitUntil: 'networkidle2' });

  // 判断查询类型
  let category = 3; // 默认按姓名
  if (/^\d{12,18}$/.test(queryText)) {
    category = 1; // 按 IC
  } else if (/^\d{11}$/.test(queryText)) {
    category = 4; // 按 Phone
  }

  // 填写搜索表单并提交
  await page.evaluate((term, cat) => {
    document.querySelector('input[name="keyword"]').value = term;
    document.querySelector('select[name="category"]').value = cat.toString();
    document.querySelector('input[type="submit"]').click();
  }, queryText, category);

  // 等待结果
  await page.waitForSelector('#dataTable tbody tr, .no-results', { timeout: 15000 });

  // 提取表格结果
  const results = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#dataTable tbody tr'));
    const items = [];
    const seen = new Set();

    rows.forEach(row => {
      const cols = row.querySelectorAll('td');
      if (cols.length >= 5) {
        const idCard = cols[0].innerText.trim();
        const name = cols[1].innerText.trim();
        const oldId = cols[2].innerText.trim();
        const address = cols[3].innerText.trim();
        const phone = cols[4].innerText.trim();

        // 用 IC / old IC 作为身份证号
        const finalId =
          idCard && idCard !== 'NULL'
            ? idCard
            : oldId && oldId !== 'NULL'
            ? oldId
            : '';

        // 过滤掉没有身份证号或没有手机号的行
        if (!finalId || !phone) return;

        // 去重 key = 身份证号 + 手机号
        const key = `${finalId}-${phone}`;
        if (seen.has(key)) return;
        seen.add(key);

        items.push({
          name: name || '未知',
          idCard: finalId,
          phone: phone,
          address: address || '未知'
        });
      }
    });

    return items;
  });

  await browser.close();
  return results;
}

module.exports = search;

