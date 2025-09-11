// login.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cookieSession = require('cookie-session');

function createTelegramLoginRouter(opts = {}) {
  const {
    BOT_TOKEN = '7868225267:AAFJgqZ1l_XjoDOEZXExKAk2rdHqx6PQr10',
    botUsername = 'leakchecksbot',
    basePath = '/auth/telegram',
    loginPath = '/login',
    successRedirect = '/me',
    sessionName = 'tg_sess',
    sessionSecret = 'leakchecksbot',   // 生产请改为强随机
    cookieSecure = false,          // 部署在 HTTPS 时设为 true
    allowSkewSeconds = 3600        // 回调签名允许的时间窗（秒）
  } = opts;

  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
  if (!botUsername) throw new Error('botUsername is required');

  const router = express.Router();

  // 自带一个仅作用于本路由的会话中间件（不影响你主应用的 session）
  router.use(cookieSession({
    name: sessionName,
    keys: [sessionSecret],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: cookieSecure
  }));

  router.use(express.urlencoded({ extended: true }));
  router.use(express.json());

  // 登录页（内嵌 Telegram SSO 小部件）
  router.get(loginPath, (req, res) => {
    const cbUrl = `${basePath}/callback`;
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://telegram.org; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; frame-src https://oauth.telegram.org https://telegram.org;");
    res.type('html').send(renderLoginHtml({ botUsername, callbackPath: cbUrl }));
  });

  // 回调校验
  router.all(`${basePath}/callback`, (req, res) => {
    const data = { ...(req.query || {}), ...(req.body || {}) };
    if (!data.hash) return res.status(400).send('Missing hash');

    const checkString = Object.keys(data)
      .filter(k => k !== 'hash')
      .sort()
      .map(k => `${k}=${data[k]}`)
      .join('\n');

    const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
    const hmac = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

    if (hmac !== String(data.hash)) return res.status(401).send('Invalid signature');

    const authDate = Number(data.auth_date || 0);
    const now = Math.floor(Date.now() / 1000);
    if (!authDate || Math.abs(now - authDate) > allowSkewSeconds) {
      return res.status(401).send('Login expired');
    }

    // 设置登录会话
    req.session.user = {
      id: String(data.id),
      first_name: data.first_name,
      last_name: data.last_name,
      username: data.username,
      photo_url: data.photo_url,
      language_code: data.language_code,
      auth_at: authDate
    };

    return res.redirect(successRedirect);
  });

  // 一个简单的 /me 页面（可选）
  router.get('/me', (req, res) => {
    if (!req.session?.user) return res.redirect(loginPath);
    const u = req.session.user;
    res.type('html').send(`
      <html><body style="font-family:sans-serif">
        <h2>已登录 ✅</h2>
        ${u.photo_url ? `<img src="${escapeHtml(u.photo_url)}" style="height:64px;border-radius:50%">` : ''}
        <pre>${escapeHtml(JSON.stringify(u, null, 2))}</pre>
        <p><a href="${basePath}/logout">退出登录</a></p>
      </body></html>
    `);
  });

  router.get(`${basePath}/logout`, (req, res) => {
    req.session = null;
    res.redirect(loginPath);
  });

  return router;
}

function mountTelegramLogin(app, opts) {
  const router = createTelegramLoginRouter(opts);
  app.use(router);
  return router;
}

function renderLoginHtml({ botUsername, callbackPath }) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>使用 Telegram 登录</title>
<style>
  html,body{height:100%} body{display:flex;align-items:center;justify-content:center;font-family:sans-serif}
  .card{padding:28px 24px;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.06);text-align:center;max-width:380px}
  h1{font-size:20px;margin:0 0 12px} p{color:#6b7280;margin:0 0 20px}
</style>
</head>
<body>
  <div class="card">
    <h1>登录到 CheckBot</h1>
    <p>使用 Telegram 一键登录</p>
    <script async src="https://telegram.org/js/telegram-widget.js?22"
      data-telegram-login="${escapeHtml(botUsername)}"
      data-size="large"
      data-auth-url="${escapeHtml(callbackPath)}"
      data-request-access="write"></script>
    <p style="margin-top:16px;font-size:12px">点击按钮即表示同意根据 Telegram 账号进行身份验证</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s='') {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

module.exports = {
  createTelegramLoginRouter,
  mountTelegramLogin
};
