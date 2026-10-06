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

// --- SECURITY MIDDLEWARE ---
// This protects all API routes with the Master Password
function checkAuth(req, res, next) {
    const correctPassword = process.env.MASTER_PASSWORD || 'admin';
    const providedPassword = req.headers['x-password'];
    
    if (providedPassword === correctPassword) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized: Incorrect Master Password' });
    }
}

// Protect Socket.io connection with Master Password
io.use((socket, next) => {
    const correctPassword = process.env.MASTER_PASSWORD || 'admin';
    const providedPassword = socket.handshake.auth.password;
    
    if (providedPassword === correctPassword) {
        next();
    } else {
        next(new Error('Unauthorized'));
    }
});

let isConnected = false;
let waSocket;

const TASKS_FILE = path.join(__dirname, 'tasks.json');
const BIRTHDAYS_FILE = path.join(__dirname, 'birthdays.json');

// Define Models at top level so they are immediately available
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
        if (!fs.existsSync(BIRTHDAYS_FILE)) fs.writeFileSync(BIRTHDAYS_FILE, JSON.stringify([]));
        
        const authState = await useMultiFileAuthState('baileys_auth_info');
        state = authState.state;
        saveCreds = authState.saveCreds;
    }

    async function connectToWhatsApp(isRestarting = false) {
        if (isRestarting) {
            console.log('Fetching completely fresh auth state...');
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

        // LIVE CHAT: Listen for incoming messages
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
                        else if (senderJid.includes('@lid')) displayPhone = "Hidden";

                        let displayName = displayPhone;
                        
                        if (process.env.MONGODB_URI) {
                            if (msg.pushName) {
                                await ContactModel.updateOne(
                                    { jid: senderJid },
                                    { jid: senderJid, phone: displayPhone, name: msg.pushName },
                                    { upsert: true }
                                );
                                displayName = `${msg.pushName} (${displayPhone})`;
                            } else {
                                const contact = await ContactModel.findOne({ jid: senderJid });
                                if (contact && contact.name) {
                                    displayName = `${contact.name} (${displayPhone})`;
                                }
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

        async function processContacts(contactsArray) {
            if (!process.env.MONGODB_URI || !contactsArray) return;
            for (const contact of contactsArray) {
                const name = contact.name || contact.notify || contact.verifiedName;
                if (name) {
                    const jid = contact.id;
                    let phone = jid;
                    if (jid.includes('@s.whatsapp.net')) phone = jid.split('@')[0];
                    else if (jid.includes('@lid')) phone = "Hidden";
                    
                    await ContactModel.updateOne({ jid }, { jid, phone, name }, { upsert: true });
                }
            }
        }

        waSocket.ev.on('contacts.upsert', async (contacts) => {
            io.emit('sync_status', 'Syncing Contacts...');
            await processContacts(contacts);
            io.emit('sync_status', 'Contacts Synced!');
            io.emit('refresh_contacts');
        });

        waSocket.ev.on('contacts.update', async (contacts) => {
            await processContacts(contacts);
            io.emit('refresh_contacts');
        });

        waSocket.ev.on('messaging-history.set', async ({ contacts }) => {
            io.emit('sync_status', 'Syncing Contacts...');
            await processContacts(contacts);
            io.emit('sync_status', 'Contacts Synced!');
            io.emit('refresh_contacts');
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
                        if (fs.existsSync('baileys_auth_info')) {
                            fs.rmSync('baileys_auth_info', { recursive: true, force: true });
                        }
                    }
                    setTimeout(() => connectToWhatsApp(true), 2000);
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

io.on('connection', (socket) => {
    socket.emit('status', isConnected ? 'Connected' : 'Connecting/Waiting for QR');
});

// Uptime Ping Endpoint (Public, no auth needed)
app.get('/api/ping', (req, res) => res.send('pong'));

// Auth check endpoint for the frontend login screen
app.post('/api/verify-password', checkAuth, (req, res) => {
    res.json({ success: true });
});

// --- CONTACTS ENDPOINT ---
app.get('/api/contacts', checkAuth, async (req, res) => {
    if (process.env.MONGODB_URI) {
        const contacts = await ContactModel.find({});
        res.json(contacts);
    } else {
        res.json([]);
    }
});

// --- LIVE CHAT ENDPOINT ---
app.post('/api/send-live', checkAuth, async (req, res) => {
    if (!isConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp not connected' });
    
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Missing fields' });

    let targetJid = phone;
    const jidMatch = phone.match(/JID:([^|]+)/);
    if (jidMatch) {
        targetJid = jidMatch[1].trim();
    } else {
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        targetJid = `${cleanPhone}@s.whatsapp.net`;
    }

    try {
        await waSocket.sendMessage(targetJid, { text: message });
        res.json({ success: true });
    } catch (err) {
        console.error('[ERROR] Live Send Failed:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});


// --- SCHEDULED TASKS ENDPOINTS ---
app.post('/api/schedule', checkAuth, async (req, res) => {
    const { phone, message, datetime } = req.body;
    if (!phone || !message || !datetime) return res.status(400).json({ error: 'Missing fields' });

    if (process.env.MONGODB_URI) {
        const newTask = new TaskModel({ phone, message, datetime });
        await newTask.save();
        res.json({ success: true, task: newTask });
    } else {
        const tasks = JSON.parse(fs.readFileSync(TASKS_FILE));
        const newTask = { id: Date.now().toString(), phone, message, datetime, status: 'pending' };
        tasks.push(newTask);
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
        res.json({ success: true, task: newTask });
    }
});

app.get('/api/tasks', checkAuth, async (req, res) => {
    if (process.env.MONGODB_URI) {
        const tasks = await TaskModel.find();
        res.json(tasks.map(t => ({ id: t._id, phone: t.phone, message: t.message, datetime: t.datetime, status: t.status })));
    } else {
        res.json(JSON.parse(fs.readFileSync(TASKS_FILE)));
    }
});

app.delete('/api/tasks/:id', checkAuth, async (req, res) => {
    if (process.env.MONGODB_URI) {
        await TaskModel.findByIdAndDelete(req.params.id);
    } else {
        let tasks = JSON.parse(fs.readFileSync(TASKS_FILE));
        tasks = tasks.filter(t => t.id !== req.params.id);
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
    }
    res.json({ success: true });
});

// --- BIRTHDAY REPOSITORY ENDPOINTS ---
app.post('/api/birthdays', checkAuth, async (req, res) => {
    const { name, phone, date } = req.body;
    if (!name || !date) return res.status(400).json({ error: 'Missing fields' });

    const dateObj = new Date(date);
    const month = dateObj.getMonth() + 1; // 1-12
    const day = dateObj.getDate(); // 1-31

    if (process.env.MONGODB_URI) {
        const newBday = new BirthdayModel({ name, phone, month, day });
        await newBday.save();
        res.json({ success: true, birthday: newBday });
    } else {
        const bdays = JSON.parse(fs.readFileSync(BIRTHDAYS_FILE));
        const newBday = { id: Date.now().toString(), name, phone, month, day };
        bdays.push(newBday);
        fs.writeFileSync(BIRTHDAYS_FILE, JSON.stringify(bdays, null, 2));
        res.json({ success: true, birthday: newBday });
    }
});

app.get('/api/birthdays', checkAuth, async (req, res) => {
    if (process.env.MONGODB_URI) {
        const bdays = await BirthdayModel.find();
        res.json(bdays.map(b => ({ id: b._id, name: b.name, phone: b.phone, month: b.month, day: b.day })));
    } else {
        res.json(JSON.parse(fs.readFileSync(BIRTHDAYS_FILE)));
    }
});

app.delete('/api/birthdays/:id', checkAuth, async (req, res) => {
    if (process.env.MONGODB_URI) {
        await BirthdayModel.findByIdAndDelete(req.params.id);
    } else {
        let bdays = JSON.parse(fs.readFileSync(BIRTHDAYS_FILE));
        bdays = bdays.filter(b => b.id !== req.params.id);
        fs.writeFileSync(BIRTHDAYS_FILE, JSON.stringify(bdays, null, 2));
    }
    res.json({ success: true });
});

// --- CRON JOB WORKER ---
let lastBirthdayCheckDate = null;

cron.schedule('* * * * *', async () => {
    if (!isConnected || !waSocket) return;
    const now = new Date();
    
    // 1. Process Scheduled Messages
    if (process.env.MONGODB_URI) {
        const tasks = await TaskModel.find({ status: 'pending' });
        for (const task of tasks) {
            if (now >= new Date(task.datetime)) {
                try {
                    let targetJid = task.phone;
                    const jidMatch = task.phone.match(/JID:([^|]+)/);
                    if (jidMatch) {
                        targetJid = jidMatch[1].trim();
                    } else {
                        const cleanPhone = task.phone.replace(/[^0-9]/g, '');
                        targetJid = `${cleanPhone}@s.whatsapp.net`;
                    }

                    await waSocket.sendMessage(targetJid, { text: task.message });
                    console.log(`[SUCCESS] Sent message to ${targetJid}`);
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
                    let targetJid = tasks[i].phone;
                    const jidMatch = tasks[i].phone.match(/JID:([^|]+)/);
                    if (jidMatch) {
                        targetJid = jidMatch[1].trim();
                    } else {
                        const cleanPhone = tasks[i].phone.replace(/[^0-9]/g, '');
                        targetJid = `${cleanPhone}@s.whatsapp.net`;
                    }
                    await waSocket.sendMessage(targetJid, { text: tasks[i].message });
                    console.log(`[SUCCESS] Sent message to ${targetJid}`);
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

    // 2. Process Birthday Reminders
    const todayString = now.toDateString();
    if (lastBirthdayCheckDate !== todayString && now.getHours() >= 10) {
        lastBirthdayCheckDate = todayString;
        
        const targetDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        const targetMonth = targetDate.getMonth() + 1;
        const targetDay = targetDate.getDate();
        
        let upcomingBirthdays = [];
        if (process.env.MONGODB_URI) {
            upcomingBirthdays = await BirthdayModel.find({ month: targetMonth, day: targetDay });
        } else {
            const bdays = JSON.parse(fs.readFileSync(BIRTHDAYS_FILE));
            upcomingBirthdays = bdays.filter(b => b.month === targetMonth && b.day === targetDay);
        }

        const myJid = waSocket.user.id.split(':')[0] + '@s.whatsapp.net';
        
        for (const b of upcomingBirthdays) {
            try {
                const text = `🎂 *Birthday Reminder!* 🎂\n\n${b.name}'s birthday is coming up in exactly 3 days!\n\nDon't forget to open your cloud scheduler and set up their birthday message.`;
                await waSocket.sendMessage(myJid, { text });
            } catch (err) {}
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
