require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const mongoose = require('mongoose');

const { makeWASocket, fetchLatestBaileysVersion, DisconnectReason, initAuthCreds, BufferJSON, useMultiFileAuthState } = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

let isConnected = false;
let waSocket;

const TASKS_FILE = path.join(__dirname, 'tasks.json');

// Define Models at top level so they are immediately available
let TaskModel;
const AuthModel = mongoose.model('Auth', new mongoose.Schema({
    _id: String,
    data: String
}, { _id: false }));

if (process.env.MONGODB_URI) {
    TaskModel = mongoose.model('Task', new mongoose.Schema({
        phone: String,
        message: String,
        datetime: String,
        status: { type: String, default: 'pending' }
    }));
}

async function useMongoDBAuthState() {
    let creds;
    const existingCreds = await AuthModel.findById('creds');
    if (existingCreds) {
        creds = JSON.parse(existingCreds.data, BufferJSON.reviver);
    } else {
        creds = initAuthCreds();
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        const val = await AuthModel.findById(`${type}-${id}`);
                        if (val) {
                            data[id] = JSON.parse(val.data, BufferJSON.reviver);
                        }
                    }));
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const name = `${category}-${id}`;
                            if (value) {
                                await AuthModel.findByIdAndUpdate(name, { _id: name, data: JSON.stringify(value, BufferJSON.replacer) }, { upsert: true });
                            } else {
                                await AuthModel.findByIdAndDelete(name);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: async () => {
            await AuthModel.findByIdAndUpdate('creds', { _id: 'creds', data: JSON.stringify(creds, BufferJSON.replacer) }, { upsert: true });
        }
    };
}

async function initializeApp() {
    let state, saveCreds;

    if (process.env.MONGODB_URI) {
        console.log('☁️ [CLOUD MODE] Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB!');

        const authState = await useMongoDBAuthState();
        state = authState.state;
        saveCreds = authState.saveCreds;
    } else {
        console.log('💻 [LOCAL MODE] Using local files...');
        if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, JSON.stringify([]));
        const authState = await useMultiFileAuthState('baileys_auth_info');
        state = authState.state;
        saveCreds = authState.saveCreds;
    }

    async function connectToWhatsApp() {
        const { version } = await fetchLatestBaileysVersion();
        
        waSocket = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Scheduler', 'Chrome', '1.0.0']
        });

        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('QR Code generated! Sending to website...');
                const qrDataURL = await QRCode.toDataURL(qr);
                io.emit('qr', qrDataURL);
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed, reconnecting:', shouldReconnect);
                isConnected = false;
                io.emit('status', 'Disconnected');
                
                if (shouldReconnect) {
                    connectToWhatsApp();
                } else {
                    console.log('Logged out. Session wiped. Restarting scanner...');
                    if (process.env.MONGODB_URI) {
                        await AuthModel.deleteMany({});
                    } else {
                        fs.rmSync('baileys_auth_info', { recursive: true, force: true });
                    }
                    connectToWhatsApp();
                }
            } else if (connection === 'open') {
                console.log('📱 Connected to WhatsApp successfully!');
                isConnected = true;
                io.emit('status', 'Connected');
                io.emit('qr', null);
            }
        });

        waSocket.ev.on('creds.update', saveCreds);
    }

    connectToWhatsApp();
}

initializeApp().catch(console.error);

// Socket.io for real-time frontend updates
io.on('connection', (socket) => {
    socket.emit('status', isConnected ? 'Connected' : 'Connecting/Waiting for QR');
});

// Uptime Ping Endpoint
app.get('/api/ping', (req, res) => res.send('pong'));

// API endpoint to schedule a message
app.post('/api/schedule', async (req, res) => {
    const { phone, message, datetime } = req.body;
    if (!phone || !message || !datetime) return res.status(400).json({ error: 'Missing fields' });

    const cleanPhone = phone.replace(/[^0-9]/g, '');

    if (process.env.MONGODB_URI) {
        const newTask = new TaskModel({ phone: cleanPhone, message, datetime });
        await newTask.save();
        res.json({ success: true, task: newTask });
    } else {
        const tasks = JSON.parse(fs.readFileSync(TASKS_FILE));
        const newTask = { id: Date.now().toString(), phone: cleanPhone, message, datetime, status: 'pending' };
        tasks.push(newTask);
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
        res.json({ success: true, task: newTask });
    }
});

// API endpoint to get tasks
app.get('/api/tasks', async (req, res) => {
    if (process.env.MONGODB_URI) {
        const tasks = await TaskModel.find();
        res.json(tasks.map(t => ({ id: t._id, phone: t.phone, message: t.message, datetime: t.datetime, status: t.status })));
    } else {
        res.json(JSON.parse(fs.readFileSync(TASKS_FILE)));
    }
});

// API endpoint to delete a task
app.delete('/api/tasks/:id', async (req, res) => {
    if (process.env.MONGODB_URI) {
        await TaskModel.findByIdAndDelete(req.params.id);
    } else {
        let tasks = JSON.parse(fs.readFileSync(TASKS_FILE));
        tasks = tasks.filter(t => t.id !== req.params.id);
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
    }
    res.json({ success: true });
});

// Cron job running every minute to check for messages to send
cron.schedule('* * * * *', async () => {
    if (!isConnected || !waSocket) return;
    const now = new Date();
    
    if (process.env.MONGODB_URI) {
        const tasks = await TaskModel.find({ status: 'pending' });
        for (const task of tasks) {
            if (now >= new Date(task.datetime)) {
                try {
                    await waSocket.sendMessage(`${task.phone}@s.whatsapp.net`, { text: task.message });
                    console.log(`[SUCCESS] Sent message to ${task.phone}`);
                    task.status = 'sent';
                } catch (err) {
                    console.error(`[ERROR] Failed to send:`, err);
                    task.status = 'failed';
                }
                await task.save();
            }
        }
    } else {
        const tasks = JSON.parse(fs.readFileSync(TASKS_FILE));
        let updated = false;
        for (let i = 0; i < tasks.length; i++) {
            if (tasks[i].status === 'pending' && now >= new Date(tasks[i].datetime)) {
                try {
                    await waSocket.sendMessage(`${tasks[i].phone}@s.whatsapp.net`, { text: tasks[i].message });
                    console.log(`[SUCCESS] Sent message to ${tasks[i].phone}`);
                    tasks[i].status = 'sent';
                } catch (err) {
                    console.error(`[ERROR] Failed to send:`, err);
                    tasks[i].status = 'failed';
                }
                updated = true;
            }
        }
        if (updated) fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(` WhatsApp Scheduler is running!`);
    console.log(` Open http://localhost:${PORT} in your browser.`);
    console.log(`===========================================`);
});
