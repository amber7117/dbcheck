const mongoose = require("mongoose");

const CookieSchema = new mongoose.Schema({
  name: { type: String, default: "zowner" }, // fixed name since only 1 site
  cookies: { type: Array, required: true },  // puppeteer cookies array
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Cookie", CookieSchema);
