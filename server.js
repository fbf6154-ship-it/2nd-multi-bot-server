const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const BOTS_DIR = path.join(__dirname, 'uploaded_bots');

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR);
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, BOTS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const cleanName = Date.now() + '-' + path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_') + ext;
        cb(null, cleanName);
    }
});
const upload = multer({ storage });

const runningProcesses = new Map();

function getBots() {
    try {
        return JSON.parse(fs.readFileSync(DB_FILE));
    } catch {
        return [];
    }
}

function saveBots(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ইউনিভার্সাল বট লঞ্চার
function launchBot(bot) {
    if (runningProcesses.has(bot.id)) {
        try { runningProcesses.get(bot.id).kill(); } catch (e) {}
    }

    console.log(`[STARTING] ${bot.name} (${bot.filename}) চালু করা হচ্ছে...`);
    const filePath = path.join(BOTS_DIR, bot.filename);

    if (!fs.existsSync(filePath)) {
        console.error(`[ERROR] ফাইল পাওয়া যায়নি: ${bot.filename}`);
        return;
    }

    let runner = bot.filename.endsWith('.py') ? 'python3' : 'node';

    const processInstance = spawn(runner, [filePath], {
        env: { ...process.env, BOT_TOKEN: bot.token }
    });

    runningProcesses.set(bot.id, processInstance);

    processInstance.stdout.on('data', (data) => console.log(`[${bot.name}]: ${data.toString()}`));
    processInstance.stderr.on('data', (data) => console.error(`[${bot.name} ERROR]: ${data.toString()}`));

    processInstance.on('close', (code) => {
        console.log(`[${bot.name}] বন্ধ হয়েছিল! ৫ সেকেন্ড পর রিস্টার্ট হচ্ছে...`);
        setTimeout(() => {
            const bots = getBots();
            const exists = bots.find(b => b.id === bot.id);
            if (exists) launchBot(bot);
        }, 5000);
    });
}

// UptimeRobot Keep-Alive
app.get('/ping', (req, res) => res.send('Active 24/7!'));

// চলমান সব বটের লিস্ট
app.get('/api/bots', (req, res) => {
    const bots = getBots().map(b => ({
        id: b.id,
        name: b.name,
        filename: b.filename,
        token: b.token,
        createdAt: b.createdAt,
        type: b.filename.endsWith('.py') ? 'Python' : 'Node.js',
        status: runningProcesses.has(b.id) ? 'Active' : 'Restarting'
    }));
    res.json(bots);
});

// নির্দিষ্ট একটি বটের সম্পূর্ণ ডাটা ও কোড পাওয়ার API
app.get('/api/bots/:id', (req, res) => {
    const bot = getBots().find(b => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: 'বট পাওয়া যায়নি!' });

    const filePath = path.join(BOTS_DIR, bot.filename);
    let code = '';
    if (fs.existsSync(filePath)) {
        code = fs.readFileSync(filePath, 'utf-8');
    }

    res.json({
        id: bot.id,
        name: bot.name,
        token: bot.token,
        filename: bot.filename,
        code: code
    });
});

// নতুন বট আপলোড
app.post('/api/upload', upload.single('botFile'), (req, res) => {
    const { botName, botToken, botCode, codeType } = req.body;
    let filename = '';

    if (req.file) {
        filename = req.file.filename;
    } else if (botCode && botCode.trim() !== '') {
        const ext = codeType === 'python' ? '.py' : '.js';
        filename = Date.now() + '-bot' + ext;
        fs.writeFileSync(path.join(BOTS_DIR, filename), botCode);
    } else {
        return res.status(400).json({ error: 'ফাইল আপলোড করুন অথবা কোড লিখুন!' });
    }

    if (!botName || !botToken) {
        return res.status(400).json({ error: 'বটের নাম ও টোকেন আবশ্যক!' });
    }

    const newBot = {
        id: Date.now().toString(),
        name: botName.trim(),
        token: botToken.trim(),
        filename: filename,
        createdAt: new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' })
    };

    const bots = getBots();
    bots.push(newBot);
    saveBots(bots);

    launchBot(newBot);

    res.json({ success: true, message: `${botName} সফলভাবে লাইভ হয়েছে!` });
});

// রানিং বটের কোড এবং টোকেন এডিট ও সাথে সাথে রিস্টার্ট করার API
app.post('/api/bots/:id/edit', (req, res) => {
    const { botName, botToken, botCode } = req.body;
    const { id } = req.params;

    let bots = getBots();
    const index = bots.findIndex(b => b.id === id);

    if (index === -1) return res.status(404).json({ error: 'বট পাওয়া যায়নি!' });

    // তথ্য আপডেট করা
    bots[index].name = botName.trim();
    bots[index].token = botToken.trim();
    saveBots(bots);

    // কোড ফাইল ওভাররাইট করা
    const filePath = path.join(BOTS_DIR, bots[index].filename);
    fs.writeFileSync(filePath, botCode, 'utf-8');

    // নতুন কোড ও টোকেন দিয়ে তৎক্ষণাৎ রিস্টার্ট দেওয়া
    launchBot(bots[index]);

    res.json({ success: true, message: 'বট সফলভাবে আপডেট ও নতুন করে রান হয়েছে!' });
});

// বট ডিলিট
app.delete('/api/bots/:id', (req, res) => {
    const { id } = req.params;
    let bots = getBots();
    const bot = bots.find(b => b.id === id);

    if (bot) {
        if (runningProcesses.has(id)) {
            runningProcesses.get(id).kill();
            runningProcesses.delete(id);
        }
        const filePath = path.join(BOTS_DIR, bot.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

        bots = bots.filter(b => b.id !== id);
        saveBots(bots);
        return res.json({ success: true });
    }
    res.status(404).json({ error: 'বট পাওয়া যায়নি!' });
});

app.listen(PORT, () => {
    console.log(`🚀 ইউনিভার্সাল এডিটেবল সার্ভার চালু হয়েছে পোর্ট: ${PORT}`);
    const bots = getBots();
    bots.forEach(bot => launchBot(bot));
});
