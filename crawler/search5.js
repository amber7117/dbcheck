const axios = require("axios");
const qs = require("qs");
const cheerio = require("cheerio");
const Cookie = require("../models/cookie");
const login = require("./login");

async function getCookies() {
  let dbCookies = await Cookie.findOne({ name: "zowner" });
  if (!dbCookies) {
    await login();
    dbCookies = await Cookie.findOne({ name: "zowner" });
  }
  return dbCookies.cookies;
}

async function search(queryText) {
  const cookies = await getCookies();

  let category = 3;
  if (/^\d{12,18}$/.test(queryText)) category = 1;
  else if (/^\d{11}$/.test(queryText)) category = 4;

  try {
    const res = await axios.post(
      "https://zowner.info/index.php",
      qs.stringify({
        keyword: queryText,
        category: category
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookies.join("; ")
        }
      }
    );

    // 如果被踢回登录页
    if (res.data.includes("login.php")) {
      console.log("⚠️ Session expired, re-login...");
      await login();
      return search(queryText);
    }

    // 用 cheerio 解析表格
    const $ = cheerio.load(res.data);
    const items = [];
    const seen = new Set();

    $("#dataTable tbody tr").each((i, el) => {
      const cols = $(el).find("td");
      if (cols.length >= 5) {
        const idCard = $(cols[0]).text().trim();
        const name = $(cols[1]).text().trim();
        const oldId = $(cols[2]).text().trim();
        const address = $(cols[3]).text().trim();
        const phone = $(cols[4]).text().trim();

        const finalId = idCard && idCard !== "NULL"
          ? idCard
          : (oldId && oldId !== "NULL" ? oldId : "");

        if (!finalId || !phone) return;

        const key = `${finalId}-${phone}`;
        if (seen.has(key)) return;
        seen.add(key);

        items.push({ name, idCard: finalId, phone, address });
      }
    });

    return items;
  } catch (err) {
    console.error("❌ Search request failed:", err.message);
    throw err;
  }
}

module.exports = search;

