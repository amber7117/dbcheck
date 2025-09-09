const fs = require('fs');
const path = require('path');

async function debugDump(page, tag = 'fail') {
  try {
    const dir = path.join('/tmp', 'crawler_debug');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(dir, `${ts}-${tag}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(`${base}.html`, html);
    console.log('[DUMP]', base);
  } catch (_) {}
}

module.exports = { debugDump };
