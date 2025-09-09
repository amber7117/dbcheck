const axios = require("axios");
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const cheerio = require("cheerio");
const Cookie = require("../models/cookie");

async function login() {
  const jar = new tough.CookieJar();
  const client = wrapper(axios.create({ jar }));

  // Step 1: GET login.php
  const loginPage = await client.get("https://zowner.info/login.php");
  const $ = cheerio.load(loginPage.data);

  // Extract hidden inputs (e.g., CSRF token)
  const formData = {
    myusername: process.env.ZOWNER_USER || "hayden",
    mypassword: process.env.ZOWNER_PASS || "123456",
  };

  $("form.login-form input[type=hidden]").each((i, el) => {
    const name = $(el).attr("name");
    const value = $(el).attr("value") || "";
    if (name) formData[name] = value;
  });

  // Step 2: POST login_process.php
  const res = await client.post(
    "https://zowner.info/login_process.php",
    new URLSearchParams(formData).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  // Step 3: Check if login success (no redirect to login.php)
  if (res.request.res.responseUrl.includes("login.php")) {
    throw new Error("❌ Login failed, wrong username/password or missing token");
  }

  // Save cookies
  const cookies = await jar.getCookies("https://zowner.info");
  await Cookie.findOneAndUpdate(
    { name: "zowner" },
    { cookies, updatedAt: new Date() },
    { upsert: true }
  );

  console.log("✅ Login success, cookies saved to DB.");
  return client;
}

module.exports = login;

if (require.main === module) {
  login().catch(e => {
    console.error("❌ Failed to login:", e.message);
    process.exit(1);
  });
}

