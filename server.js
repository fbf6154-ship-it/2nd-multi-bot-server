const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 10000;

// ফোল্ডার পাথ তৈরি
const BOTS_DIR = path.join(__dirname, 'bots_storage');
const DB_FILE = path.join(__dirname, 'bots_db.json');

if (!fs.existsSync(BOTS_DIR)) {
    fs.mkdirSync(BOTS_DIR, { recursive: true });
}

// ডাটাবেজ হেল্পার
function getBotsDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify([]));
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function saveBotsDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// রানিং প্রসেস ট্র্যাকার
const runningProcesses = {};

// বট রান করার ফাংশন
function startBotProcess(bot) {
    // আগের প্রসেস চালু থাকলে বন্ধ করা
    if (runningProcesses[bot.id]) {
        try {
            runningProcesses[bot.id].kill();
        } catch (e) {}
        delete runningProcesses[bot.id];
    }

    const filePath = path.join(BOTS_DIR, bot.filename);
    if (!fs.existsSync(filePath)) {
        console.error(`[Error] ফাইল পাওয়া যায়নি: ${filePath}`);
        return false;
    }

    const env = {
        ...process.env,
        BOT_TOKEN: bot.token,
        PYTHONUNBUFFERED: "1"
    };

    let cmd = 'node';
    let args = [filePath];

    if (bot.type === 'python') {
        cmd = 'python3';
        args = [filePath];
    }

    console.log(`🚀 [Starting Bot] ${bot.name} (${cmd} ${bot.filename})...`);

    try {
        const proc = spawn(cmd, args, {
            env: env,
            cwd: BOTS_DIR,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        proc.stdout.on('data', (data) => {
            console.log(`[Bot: ${bot.name}] ${data.toString().trim()}`);
        });

        proc.stderr.on('data', (data) => {
            console.error(`[Bot Error: ${bot.name}] ${data.toString().trim()}`);
        });

        proc.on('close', (code) => {
            console.log(`[Bot Stopped] ${bot.name} (Exit Code: ${code})`);
            delete runningProcesses[bot.id];
        });

        proc.on('error', (err) => {
            console.error(`[Failed to spawn] ${bot.name}:`, err.message);
        });

        runningProcesses[bot.id] = proc;
        return true;
    } catch (err) {
        console.error(`[Bot Start Error]:`, err);
        return false;
    }
}

// মিডলওয়্যার
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// মুল্টার ফাইল আপলোড কনফিগ
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ================= API ROUTES =================

// ১. সকল বটের তালিকা
app.get('/api/bots', (req, res) => {
    const bots = getBotsDB();
    res.json(bots);
});

// ২. নির্দিষ্ট বটের তথ্য ও কোড দেখা
app.get('/api/bots/:id', (req, res) => {
    const bots = getBotsDB();
    const bot = bots.find(b => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: 'বটটি পাওয়া যায়নি!' });

    const filePath = path.join(BOTS_DIR, bot.filename);
    let code = '';
    if (fs.existsSync(filePath)) {
        code = fs.readFileSync(filePath, 'utf8');
    }
    res.json({ ...bot, code });
});

// ৩. নতুন বট আপলোড ও হোস্ট
app.post('/api/upload', upload.single('botFile'), (req, res) => {
    try {
        const { botName, botToken, botCode, codeType } = req.body;
        if (!botName || !botToken) {
            return res.status(400).json({ error: 'বটের নাম এবং টোকেন দেওয়া বাধ্যতামূলক!' });
        }

        const id = 'bot_' + Date.now();
        const ext = codeType === 'javascript' ? '.js' : '.py';
        const filename = `${id}${ext}`;
        const filePath = path.join(BOTS_DIR, filename);

        let finalCode = '';
        if (req.file) {
            finalCode = req.file.buffer.toString('utf8');
        } else if (botCode && botCode.trim()) {
            finalCode = botCode;
        } else {
            return res.status(400).json({ error: 'কোনো কোড বা ফাইল আপলোড করা হয়নি!' });
        }

        fs.writeFileSync(filePath, finalCode, 'utf8');

        const newBot = {
            id: id,
            name: botName.trim(),
            token: botToken.trim(),
            type: codeType === 'javascript' ? 'nodejs' : 'python',
            filename: filename,
            createdAt: new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' })
        };

        const bots = getBotsDB();
        bots.push(newBot);
        saveBotsDB(bots);

        startBotProcess(newBot);

        res.json({ success: true, message: 'বট সফলভাবে হোস্ট ও চালু হয়েছে!' });
    } catch (e) {
        console.error('Upload Error:', e);
        res.status(500).json({ error: 'বট আপলোডে সমস্যা হয়েছে: ' + e.message });
    }
});

// ৪. বটের কোড বা টোকেন লাইভ এডিট ও রিস্টার্ট
app.post('/api/bots/:id/edit', (req, res) => {
    try {
        const { botName, botToken, botCode } = req.body;
        const bots = getBotsDB();
        const index = bots.findIndex(b => b.id === req.params.id);

        if (index === -1) {
            return res.status(404).json({ error: 'বটটি পাওয়া যায়নি!' });
        }

        const bot = bots[index];
        bot.name = botName || bot.name;
        bot.token = botToken || bot.token;

        const filePath = path.join(BOTS_DIR, bot.filename);
        fs.writeFileSync(filePath, botCode, 'utf8');

        saveBotsDB(bots);
        startBotProcess(bot);

        res.json({ success: true, message: 'বট সফলভাবে আপডেট ও রিস্টার্ট হয়েছে!' });
    } catch (e) {
        res.status(500).json({ error: 'আপডেটে সমস্যা হয়েছে: ' + e.message });
    }
});

// ৫. বট বন্ধ ও ডিলিট করা
app.delete('/api/bots/:id', (req, res) => {
    try {
        let bots = getBotsDB();
        const bot = bots.find(b => b.id === req.params.id);

        if (bot) {
            if (runningProcesses[bot.id]) {
                try {
                    runningProcesses[bot.id].kill();
                } catch (e) {}
                delete runningProcesses[bot.id];
            }

            const filePath = path.join(BOTS_DIR, bot.filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }

            bots = bots.filter(b => b.id !== req.params.id);
            saveBotsDB(bots);
        }

        res.json({ success: true, message: 'বটটি ডিলিট করা হয়েছে!' });
    } catch (e) {
        res.status(500).json({ error: 'ডিলিট করতে সমস্যা হয়েছে: ' + e.message });
    }
});

// সার্ভার রিস্টার্ট হলে পূর্বের সকল বট অটো-স্টার্ট
function restartAllSavedBots() {
    const bots = getBotsDB();
    console.log(`[Auto-Start] পূর্বের ${bots.length}টি বট চালু করা হচ্ছে...`);
    bots.forEach(bot => {
        startBotProcess(bot);
    });
}

app.listen(PORT, () => {
    console.log(`🚀 ইউনিভার্সাল এডিটেবল সার্ভার চালু হয়েছে পোর্ট: ${PORT}`);
    restartAllSavedBots();
});
