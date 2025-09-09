// crawler/search.js
const axios = require("axios");
const cheerio = require("cheerio");
const CookieModel = require("../models/cookie");
const login = require("./login");

async function ensureCookies() {
  let cookieDoc = await CookieModel.findOne({ name: "zowner" });
  if (!cookieDoc) {
    console.log("⚠️ No cookies found, logging in...");
    await login();
    cookieDoc = await CookieModel.findOne({ name: "zowner" });
  }
  return cookieDoc.cookies;
}

async function search(queryText) {
  try {
    let cookies = await ensureCookies();

    // 判断搜索类型
    let category = 3; // name
    if (/^\d{12,18}$/.test(queryText)) category = 1; // IC
    else if (/^\d{11}$/.test(queryText)) category = 4; // phone

    // 发起搜索请求
    const res = await axios.post(
      "https://zowner.info/index.php",
      new URLSearchParams({
        keyword: queryText,
        category: category.toString(),
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookies,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
          Referer: "https://zowner.info/index.php",
        },
      }
    );

    // 如果返回页面跳转回 login.php，说明 session 失效，重新登录
    if (res.data.includes("login.php") || res.request.res.responseUrl.includes("login.php")) {
      console.log("⚠️ Session expired, re-login...");
      await login();
      return await search(queryText);
    }

    // 解析结果页面
    const $ = cheerio.load(res.data);
    const rows = $("#dataTable tbody tr");
    const items = [];
    const seen = new Set();

    rows.each((_, row) => {
      const cols = $(row).find("td");
      if (cols.length >= 5) {
        const idCard = $(cols[0]).text().trim();
        const name = $(cols[1]).text().trim();
        const oldId = $(cols[2]).text().trim();
        const address = $(cols[3]).text().trim();
        const phone = $(cols[4]).text().trim();

        const finalId =
          idCard && idCard !== "NULL"
            ? idCard
            : oldId && oldId !== "NULL"
            ? oldId
            : "";
        if (!finalId || !phone) return;

        const key = `${finalId}-${phone}`;
        if (seen.has(key)) return;
        seen.add(key);

        items.push({
          name: name || "未知",
          idCard: finalId,
          phone,
          address: address || "未知",
        });
      }
    });

    return items;
  } catch (err) {
    console.error("❌ Search error:", err.message || err);
    throw err;
  }
}

module.exports = search;

