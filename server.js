require('dotenv').config();
const express = require('express');
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

let isConnected = false;
let waClient;

// --- DATABASE SETUP (Local OR Cloud) ---
let TaskModel;
const TASKS_FILE = path.join(__dirname, 'tasks.json');

async function initializeApp() {
    let authStrategy;

    if (process.env.MONGODB_URI) {
        console.log('☁️ [CLOUD MODE] Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB!');

        // Define Cloud Schema for Messages
        const taskSchema = new mongoose.Schema({
            phone: String,
            message: String,
            datetime: String, // UTC ISO string to completely avoid timezone bugs
            status: { type: String, default: 'pending' }
        });
        TaskModel = mongoose.model('Task', taskSchema);

        const store = new MongoStore({ mongoose: mongoose });
        authStrategy = new RemoteAuth({ 
            store: store, 
            backupSyncIntervalMs: 300000 
        });
    } else {
        console.log('💻 [LOCAL MODE] Using local files...');
        if (!fs.existsSync(TASKS_FILE)) {
            fs.writeFileSync(TASKS_FILE, JSON.stringify([]));
        }
        authStrategy = new LocalAuth({ clientId: "scheduler" });
    }

    // --- PUPPETEER RAM OPTIMIZATION ---
    // Extremely strict limits to stay safely under 512MB RAM free cloud limits
    const puppeteerArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--mute-audio',
        '--disable-software-rasterizer',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--enable-features=NetworkService,NetworkServiceInProcess'
    ];

    // Linux (Cloud) can use single-process to save RAM, but Windows crashes with it.
    if (process.platform === 'linux') {
        puppeteerArgs.push('--single-process'); 
    }

    waClient = new Client({
        authStrategy: authStrategy,
        puppeteer: {
            headless: true,
            args: puppeteerArgs
        }
    });

    waClient.on('qr', async (qr) => {
        console.log('QR Code generated! Sending to website...');
        const qrDataURL = await QRCode.toDataURL(qr);
        io.emit('qr', qrDataURL);
    });

    waClient.on('remote_session_saved', () => {
        console.log('✅ Cloud Session securely saved to MongoDB!');
    });

    waClient.on('ready', () => {
        console.log('📱 Connected to WhatsApp successfully!');
        isConnected = true;
        io.emit('status', 'Connected');
        io.emit('qr', null); 
    });

    waClient.on('auth_failure', msg => {
        console.error('AUTHENTICATION FAILURE', msg);
    });

    waClient.on('disconnected', (reason) => {
        console.log('WhatsApp disconnected:', reason);
        isConnected = false;
        io.emit('status', 'Disconnected');
        waClient.initialize().catch(console.error);
    });

    console.log('Initializing WhatsApp background browser...');
    waClient.initialize().catch(err => {
        console.error('FAILED TO INITIALIZE WHATSAPP:', err);
    });
}

initializeApp().catch(console.error);

// Socket.io for real-time frontend updates
io.on('connection', (socket) => {
    socket.emit('status', isConnected ? 'Connected' : 'Connecting/Waiting for QR');
});

// --- API ENDPOINTS ---

// Uptime Ping Endpoint (For UptimeRobot to keep server awake)
app.get('/api/ping', (req, res) => {
    res.send('pong');
});

app.post('/api/schedule', async (req, res) => {
    const { phone, message, datetime } = req.body;
    
    if (!phone || !message || !datetime) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    const cleanPhone = phone.replace(/[^0-9]/g, '');

    if (process.env.MONGODB_URI) {
        const newTask = new TaskModel({ phone: cleanPhone, message, datetime });
        await newTask.save();
        res.json({ success: true, task: newTask });
    } else {
        const tasks = JSON.parse(fs.readFileSync(TASKS_FILE));
        const newTask = {
            id: Date.now().toString(),
            phone: cleanPhone,
            message,
            datetime, // UTC ISO string
            status: 'pending'
        };
        tasks.push(newTask);
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
        res.json({ success: true, task: newTask });
    }
});

app.get('/api/tasks', async (req, res) => {
    if (process.env.MONGODB_URI) {
        const tasks = await TaskModel.find();
        // map _id to id for frontend to read
        const mapped = tasks.map(t => ({ id: t._id, phone: t.phone, message: t.message, datetime: t.datetime, status: t.status }));
        res.json(mapped);
    } else {
        const tasks = JSON.parse(fs.readFileSync(TASKS_FILE));
        res.json(tasks);
    }
});

app.delete('/api/tasks/:id', async (req, res) => {
    if (process.env.MONGODB_URI) {
        await TaskModel.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } else {
        let tasks = JSON.parse(fs.readFileSync(TASKS_FILE));
        tasks = tasks.filter(t => t.id !== req.params.id);
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
        res.json({ success: true });
    }
});

// --- CRON JOB WORKER ---
// Checks the clock every minute
cron.schedule('* * * * *', async () => {
    if (!isConnected) return;

    const now = new Date(); // This is correctly in UTC on the cloud
    
    if (process.env.MONGODB_URI) {
        const tasks = await TaskModel.find({ status: 'pending' });
        for (const task of tasks) {
            const taskDate = new Date(task.datetime);
            if (now >= taskDate) {
                try {
                    const jid = `${task.phone}@c.us`;
                    await waClient.sendMessage(jid, task.message);
                    console.log(`[SUCCESS] Sent scheduled message to ${task.phone}`);
                    task.status = 'sent';
                } catch (error) {
                    console.error(`[ERROR] Failed to send message to ${task.phone}:`, error);
                    task.status = 'failed';
                }
                await task.save();
            }
        }
    } else {
        const tasks = JSON.parse(fs.readFileSync(TASKS_FILE));
        let tasksUpdated = false;

        for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            if (task.status === 'pending') {
                const taskDate = new Date(task.datetime);
                if (now >= taskDate) {
                    try {
                        const jid = `${task.phone}@c.us`;
                        await waClient.sendMessage(jid, task.message);
                        console.log(`[SUCCESS] Sent scheduled message to ${task.phone}`);
                        tasks[i].status = 'sent';
                    } catch (error) {
                        console.error(`[ERROR] Failed to send message to ${task.phone}:`, error);
                        tasks[i].status = 'failed';
                    }
                    tasksUpdated = true;
                }
            }
        }
        if (tasksUpdated) {
            fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(` WhatsApp Scheduler is running!`);
    console.log(` Open http://localhost:${PORT} in your browser.`);
    console.log(`===========================================`);
});
