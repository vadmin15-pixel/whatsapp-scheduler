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

// Serve index.html directly from the main folder (no public folder needed)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

function checkAuth(req, res, next) {
    const correctPassword = process.env.MASTER_PASSWORD || 'admin';
    const providedPassword = req.headers['x-password'];
    if (providedPassword === correctPassword) next();
    else res.status(401).json({ error: 'Unauthorized' });
}

io.use((socket, next) => {
    const correctPassword = process.env.MASTER_PASSWORD || 'admin';
    const providedPassword = socket.handshake.auth.password;
    if (providedPassword === correctPassword) next();
    else next(new Error('Unauthorized'));
});

let isConnected = false;
let waSocket;

const TASKS_FILE = path.join(__dirname, 'tasks.json');
const BIRTHDAYS_FILE = path.join(__dirname, 'birthdays.json');

let TaskModel;
let BirthdayModel;
let ContactModel;

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
    
    BirthdayModel = mongoose.model('Birthday', new mongoose.Schema({
        name: String,
        phone: String,
        month: Number,
        day: Number
    }));

    ContactModel = mongoose.model('Contact', new mongoose.Schema({
        phone: String,
        name: String,
        jid: String
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
                        if (val) data[id] = JSON.parse(val.data, BufferJSON.reviver);
                    }));
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const name = `${category}-${id}`;
                            if (value) await AuthModel.findByIdAndUpdate(name, { _id: name, data: JSON.stringify(value, BufferJSON.replacer) }, { upsert: true });
                            else await AuthModel.findByIdAndDelete(name);
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

        // Wipe old corrupt contacts to guarantee clean state
        console.log('🧹 Wiping old contacts to ensure clean sync...');
        await ContactModel.deleteMany({});

        const authState = await useMongoDBAuthState();
        state = authState.state;
        saveCreds = authState.saveCreds;
    } else {
        const authState = await useMultiFileAuthState('baileys_auth_info');
        state = authState.state;
        saveCreds = authState.saveCreds;
    }

    async function connectToWhatsApp(isRestarting = false) {
        if (isRestarting) {
            if (process.env.MONGODB_URI) {
                const authState = await useMongoDBAuthState();
                state = authState.state;
                saveCreds = authState.saveCreds;
            } else {
                const authState = await useMultiFileAuthState('baileys_auth_info');
                state = authState.state;
                saveCreds = authState.saveCreds;
            }
        }

        const { version } = await fetchLatestBaileysVersion();
        
        waSocket = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Scheduler', 'Chrome', '1.0.0']
        });

        // Removed automatic Baileys contact sync per user request

        // LIVE CHAT
        waSocket.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe) {
                        const remoteJid = msg.key.remoteJid;
                        const isGroup = remoteJid.endsWith('@g.us');
                        const senderJid = isGroup ? msg.key.participant : remoteJid;
                        
                        if (!senderJid) continue;

                        let displayPhone = senderJid;
                        if (senderJid.includes('@s.whatsapp.net')) displayPhone = senderJid.split('@')[0];
                        else if (senderJid.includes('@lid')) displayPhone = "Hidden Number";

                        let displayName = displayPhone;
                        
                        if (process.env.MONGODB_URI) {
                            const contact = await ContactModel.findOne({ jid: senderJid });
                            if (contact && contact.name) {
                                displayName = `${contact.name} (${displayPhone})`;
                            } else if (msg.pushName) {
                                displayName = `${msg.pushName} (${displayPhone})`;
                            }
                        }

                        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
                        if (text) {
                            io.emit('live_message_received', {
                                sender: displayName,
                                text: text,
                                timestamp: new Date().toISOString()
                            });
                        }
                    }
                }
            }
        });

        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, isNewLogin } = update;

            if (qr) {
                io.emit('qr', await QRCode.toDataURL(qr));
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
                isConnected = false;
                io.emit('status', 'Disconnected');
                
                if (shouldReconnect) {
                    connectToWhatsApp();
                } else {
                    if (process.env.MONGODB_URI) {
                        await AuthModel.deleteMany({});
                        await ContactModel.deleteMany({});
                    }
                    setTimeout(() => connectToWhatsApp(true), 2000);
                }
            } else if (connection === 'open') {
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

io.on('connection', (socket) => {
    socket.emit('status', isConnected ? 'Connected' : 'Connecting/Waiting for QR');
});

app.get('/api/ping', (req, res) => res.send('pong'));
app.post('/api/verify-password', checkAuth, (req, res) => res.json({ success: true }));

app.get('/api/contacts', checkAuth, async (req, res) => {
    if (process.env.MONGODB_URI) {
        const contacts = await ContactModel.find({});
        res.json(contacts);
    } else {
        res.json([]);
    }
});

app.post('/api/contacts/import', checkAuth, async (req, res) => {
    if (!process.env.MONGODB_URI) return res.status(400).json({ error: 'MongoDB not configured' });
    const { contacts } = req.body;
    if (!contacts || !Array.isArray(contacts)) return res.status(400).json({ error: 'Invalid data' });

    try {
        await ContactModel.deleteMany({}); // Wipe old contacts
        for (const c of contacts) {
            await ContactModel.updateOne(
                { jid: c.jid },
                { jid: c.jid, phone: c.phone, name: c.name },
                { upsert: true }
            );
        }
        res.json({ success: true, count: contacts.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Import failed' });
    }
});

app.post('/api/send-live', checkAuth, async (req, res) => {
    if (!isConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp not connected' });
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Missing fields' });

    let targetJid = phone;
    const jidMatch = phone.match(/JID:([^|]+)/);
    if (jidMatch) targetJid = jidMatch[1].trim();
    else {
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        targetJid = `${cleanPhone}@s.whatsapp.net`;
    }

    try {
        await waSocket.sendMessage(targetJid, { text: message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/schedule', checkAuth, async (req, res) => {
    const { phone, message, datetime } = req.body;
    if (process.env.MONGODB_URI) {
        const newTask = new TaskModel({ phone, message, datetime });
        await newTask.save();
        res.json({ success: true });
    }
});

app.get('/api/tasks', checkAuth, async (req, res) => {
    if (process.env.MONGODB_URI) {
        const tasks = await TaskModel.find();
        res.json(tasks.map(t => ({ id: t._id, phone: t.phone, message: t.message, datetime: t.datetime, status: t.status })));
    }
});

app.delete('/api/tasks/:id', checkAuth, async (req, res) => {
    if (process.env.MONGODB_URI) await TaskModel.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

app.post('/api/birthdays', checkAuth, async (req, res) => {
    const { name, phone, date } = req.body;
    const d = new Date(date);
    if (process.env.MONGODB_URI) {
        const newBday = new BirthdayModel({ name, phone, month: d.getMonth() + 1, day: d.getDate() });
        await newBday.save();
        res.json({ success: true });
    }
});

app.get('/api/birthdays', checkAuth, async (req, res) => {
    if (process.env.MONGODB_URI) {
        const bdays = await BirthdayModel.find();
        res.json(bdays.map(b => ({ id: b._id, name: b.name, phone: b.phone, month: b.month, day: b.day })));
    }
});

app.delete('/api/birthdays/:id', checkAuth, async (req, res) => {
    if (process.env.MONGODB_URI) await BirthdayModel.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

let lastBirthdayCheckDate = null;
cron.schedule('* * * * *', async () => {
    if (!isConnected || !waSocket) return;
    const now = new Date();
    
    if (process.env.MONGODB_URI) {
        const tasks = await TaskModel.find({ status: 'pending' });
        for (const task of tasks) {
            if (now >= new Date(task.datetime)) {
                try {
                    let targetJid = task.phone;
                    const jidMatch = task.phone.match(/JID:([^|]+)/);
                    if (jidMatch) targetJid = jidMatch[1].trim();
                    else targetJid = `${task.phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

                    await waSocket.sendMessage(targetJid, { text: task.message });
                    task.status = 'sent';
                } catch (err) { task.status = 'failed'; }
                await task.save();
            }
        }
    }

    const todayString = now.toDateString();
    if (lastBirthdayCheckDate !== todayString && now.getHours() >= 10) {
        lastBirthdayCheckDate = todayString;
        const targetDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        
        if (process.env.MONGODB_URI) {
            const upcoming = await BirthdayModel.find({ month: targetDate.getMonth() + 1, day: targetDate.getDate() });
            const myJid = waSocket.user.id.split(':')[0] + '@s.whatsapp.net';
            for (const b of upcoming) {
                try {
                    await waSocket.sendMessage(myJid, { text: `🎂 *Birthday Reminder!* 🎂\n\n${b.name}'s birthday is coming up in exactly 3 days!` });
                } catch (err) {}
            }
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on port ${PORT}`));
