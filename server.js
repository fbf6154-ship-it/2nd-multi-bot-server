const express = require('express');
const multer = require('multer');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const BOTS_DIR = path.join(__dirname, 'bots');
const DATA_FILE = path.join(__dirname, 'bots_data.json');

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

let runningProcesses = {};

// পাইথনের সাধারণ বিল্ট-ইন মডিউল (এগুলো pip দিয়ে ইন্সটল করা লাগে না)
const PYTHON_BUILTINS = new Set([
    'os', 'sys', 'time', 'json', 're', 'math', 'asyncio', 'logging', 'typing',
    'random', 'datetime', 'subprocess', 'threading', 'collections', 'shutil',
    'tempfile', 'urllib', 'base64', 'hashlib', 'uuid', 'io', 'socket', 'ssl',
    'http', 'html', 'sqlite3', 'csv', 'pathlib', 'functools', 'itertools', 'traceback'
]);

// পাইথন ইমপোর্ট এবং আসল pip প্যাকেজের সঠিক ম্যাপিং
const PACKAGE_MAP = {
    'telebot': 'pyTelegramBotAPI',
    'emoji': 'emoji',
    'telegram': 'python-telegram-bot',
    'bs4': 'beautifulsoup4',
    'cv2': 'opencv-python',
    'PIL': 'Pillow',
    'yaml': 'pyyaml',
    'dotenv': 'python-dotenv',
    'telethon': 'telethon',
    'pyrogram': 'pyrogram tgcrypto',
    'aiogram': 'aiogram',
    'google': 'google-api-python-client'
};

// কোড থেকে স্বয়ংক্রিয়ভাবে লাইব্রেরি ডিটেক্ট ও ইনস্টল করার ফাংশন
function autoInstallPythonDeps(code) {
    return new Promise((resolve) => {
        const importRegex = /(?:^|\n)\s*(?:import|from)\s+([a-zA-Z0-9_]+)/g;
        let match;
        const requiredLibs = new Set();

        while ((match = importRegex.exec(code)) !== null) {
            const mod = match[1].trim();
            if (!PYTHON_BUILTINS.has(mod)) {
                const pkg = PACKAGE_MAP[mod] || mod;
                requiredLibs.add(pkg);
            }
        }

        if (requiredLibs.size === 0) return resolve();

        const installCmd = `pip3 install --no-cache-dir ${Array.from(requiredLibs).join(' ')} || pip install --no-cache-dir ${Array.from(requiredLibs).join(' ')}`;
        console.log(`[Auto-Installer] প্যাকেজ ইনস্টল করা হচ্ছে: ${Array.from(requiredLibs).join(', ')}`);
        
        exec(installCmd, (err, stdout, stderr) => {
            if (err) {
                console.warn(`[Auto-Installer Warning]: ${stderr || err.message}`);
            } else {
                console.log(`[Auto-Installer Success] ডিপেন্ডেন্সি রেডি!`);
            }
            resolve();
        });
    });
}

function getBots() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function saveBots(bots) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(bots, null, 2));
}

// বট চালু করার ফাংশন
async function startBot(bot) {
    if (runningProcesses[bot.id]) {
        try { runningProcesses[bot.id].kill('SIGKILL'); } catch (e) {}
    }

    const filePath = path.join(BOTS_DIR, bot.filename);
    if (!fs.existsSync(filePath)) return;

    const env = { ...process.env, BOT_TOKEN: bot.token, TOKEN: bot.token };

    if (bot.type === 'python') {
        const code = fs.readFileSync(filePath, 'utf8');
        await autoInstallPythonDeps(code);
        
        const proc = spawn('python3', [filePath], { env });
        runningProcesses[bot.id] = proc;

        proc.stdout.on('data', (d) => console.log(`[${bot.name}] ${d}`));
        proc.stderr.on('data', (d) => console.error(`[${bot.name} ERROR] ${d}`));
    } else {
        const proc = spawn('node', [filePath], { env });
        runningProcesses[bot.id] = proc;

        proc.stdout.on('data', (d) => console.log(`[${bot.name}] ${d}`));
        proc.stderr.on('data', (d) => console.error(`[${bot.name} ERROR] ${d}`));
    }
}

const upload = multer({ dest: 'uploads/' });

// API: লিস্ট
app.get('/api/bots', (req, res) => {
    res.json(getBots());
});

// API: সিঙ্গেল বট
app.get('/api/bots/:id', (req, res) => {
    const bots = getBots();
    const bot = bots.find(b => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const filePath = path.join(BOTS_DIR, bot.filename);
    const code = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    res.json({ ...bot, code });
});

// API: আপলোড
app.post('/api/upload', upload.single('botFile'), async (req, res) => {
    try {
        const { botName, botToken, botCode, codeType } = req.body;
        const id = Date.now().toString();
        const ext = (req.file ? path.extname(req.file.originalname) : (codeType === 'javascript' ? '.js' : '.py')).toLowerCase();
        const filename = `${id}${ext}`;
        const targetPath = path.join(BOTS_DIR, filename);

        if (req.file) {
            fs.renameSync(req.file.path, targetPath);
        } else if (botCode) {
            fs.writeFileSync(targetPath, botCode);
        } else {
            return res.status(400).json({ error: 'কোড অথবা ফাইল প্রদান করুন।' });
        }

        const newBot = {
            id,
            name: botName,
            token: botToken,
            filename,
            type: ext === '.js' ? 'javascript' : 'python',
            createdAt: new Date().toLocaleString('bn-BD')
        };

        const bots = getBots();
        bots.push(newBot);
        saveBots(bots);

        await startBot(newBot);

        res.json({ success: true, message: 'বট সফলভাবে হোস্ট ও চালু হয়েছে!' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: এডিট
app.post('/api/bots/:id/edit', async (req, res) => {
    try {
        const { botName, botToken, botCode } = req.body;
        const bots = getBots();
        const botIndex = bots.findIndex(b => b.id === req.params.id);

        if (botIndex === -1) return res.status(404).json({ error: 'বট পাওয়া যায়নি!' });

        bots[botIndex].name = botName;
        bots[botIndex].token = botToken;
        saveBots(bots);

        const filePath = path.join(BOTS_DIR, bots[botIndex].filename);
        fs.writeFileSync(filePath, botCode);

        await startBot(bots[botIndex]);

        res.json({ success: true, message: 'বট সফলভাবে আপডেট ও রিস্টার্ট হয়েছে!' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: ডিলিট
app.delete('/api/bots/:id', (req, res) => {
    const bots = getBots();
    const bot = bots.find(b => b.id === req.params.id);

    if (bot) {
        if (runningProcesses[bot.id]) {
            try { runningProcesses[bot.id].kill('SIGKILL'); } catch (e) {}
            delete runningProcesses[bot.id];
        }
        const filePath = path.join(BOTS_DIR, bot.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

        saveBots(bots.filter(b => b.id !== req.params.id));
    }
    res.json({ success: true });
});

// সার্ভার স্টার্ট
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    const bots = getBots();
    bots.forEach(b => startBot(b));
});
