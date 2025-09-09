const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/user');
const Admin = require('../models/admin');
const Developer = require('../models/developer');
const search = require('../crawler/search');
const config = require('../config');
const csrf = require('tiny-csrf');

const router = express.Router();
const csrfProtection = csrf(
  "12345678901234567890123456789012", // secret
  ["POST"], // methods
  ["/webhook/*"] // ignored paths
);
router.use(csrfProtection);

function checkAuth(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/');
    }
}

function checkAdminAuth(req, res, next) {
    if (req.session.admin) {
        next();
    } else {
        res.redirect('/admin');
    }
}

router.get('/', (req, res) => {
    fs.readFile(path.join(__dirname, '..', 'public', 'login.html'), 'utf8', (err, data) => {
        if (err) {
            return res.status(500).send('Error reading login page');
        }
        // This is a bit of a hack, but it's the easiest way to get the bot's username
        // without making the bot instance available to the router.
        // A better solution would be to have a config file.
        res.send(data.replace('{BOT_USERNAME}', config.botUsername));
    });
});

router.get('/dashboard', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

router.get('/user/points', checkAuth, async (req, res) => {
    const user = await User.findOne({ userId: req.session.user.id });
    res.json({ points: user ? user.points : 0 });
});

router.get('/auth/telegram/callback', (req, res) => {
    const user = req.query;
    const secret = crypto.createHash('sha256').update(config.botToken).digest();
    const checkString = Object.keys(user)
        .filter(key => key !== 'hash')
        .map(key => `${key}=${user[key]}`)
        .sort()
        .join('\n');
    const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

    if (hmac === user.hash) {
        req.session.user = user;
        res.redirect('/dashboard');
    } else {
        res.status(401).send('Unauthorized');
    }
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

router.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

router.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });
    if (admin && await admin.comparePassword(password)) {
        req.session.admin = { username: admin.username };
        res.sendStatus(200);
    } else {
        res.status(401).json({ message: 'Invalid credentials' });
    }
});

router.get('/admin/dashboard', checkAdminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin_dashboard.html'));
});

router.get('/admin/users', checkAdminAuth, async (req, res) => {
    const users = await User.find();
    res.json(users);
});

router.post('/admin/user/:userId/points', checkAdminAuth, async (req, res) => {
    await User.updateOne({ userId: req.params.userId }, { points: req.body.points });
    res.sendStatus(200);
});

router.delete('/admin/user/:userId', checkAdminAuth, async (req, res) => {
    await User.deleteOne({ userId: req.params.userId });
    res.sendStatus(200);
});

router.get('/admin/developers', checkAdminAuth, async (req, res) => {
    const developers = await Developer.find();
    res.json(developers);
});

router.post('/admin/developer', checkAdminAuth, async (req, res) => {
    const { name } = req.body;
    const apiKey = crypto.randomBytes(20).toString('hex');
    const developer = new Developer({ name, apiKey });
    await developer.save();
    res.sendStatus(201);
});

router.post('/admin/developer/:apiKey/points', checkAdminAuth, async (req, res) => {
    await Developer.updateOne({ apiKey: req.params.apiKey }, { points: req.body.points });
    res.sendStatus(200);
});

router.delete('/admin/developer/:apiKey', checkAdminAuth, async (req, res) => {
    await Developer.deleteOne({ apiKey: req.params.apiKey });
    res.sendStatus(200);
});

router.get('/admin/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/admin');
    });
});

// Route to create a default admin user (for setup purposes)
router.get('/setup-admin', async (req, res) => {
    try {
        const admin = new Admin({ username: 'admin', password: 'password' });
        await admin.save();
        res.send('Admin user created');
    } catch (error) {
        res.status(500).send(error.message);
    }
});

async function apiAuth(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return res.status(401).json({ message: 'API key is required' });
    }
    const developer = await Developer.findOne({ apiKey });
    if (!developer) {
        return res.status(401).json({ message: 'Invalid API key' });
    }
    if (developer.points <= 0) {
        return res.status(402).json({ message: 'Insufficient points' });
    }
    req.developer = developer;
    next();
}

router.post('/api/query', apiAuth, async (req, res) => {
    const { query } = req.body;
    if (!query) {
        return res.status(400).json({ message: 'Query is required' });
    }
    try {
        const results = await search(query);
        if (results.length > 0) {
            await Developer.updateOne({ apiKey: req.developer.apiKey }, { $inc: { points: -1 } });
        }
        res.json(results);
    } catch (error) {
        res.status(500).json({ message: 'An error occurred' });
    }
});

router.post('/set-webhook', checkAuth, async (req, res) => {
    const { botToken, renderUrl } = req.body;
    const webhookUrl = `${renderUrl}/webhook/${botToken}`;
    try {
        const response = await axios.get(`https://api.telegram.org/bot${botToken}/setWebhook?url=${webhookUrl}`);
        res.send(response.data);
    } catch (error) {
        res.status(500).send(error);
    }
});

module.exports = router;
