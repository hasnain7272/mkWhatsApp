const { 
    default: makeWASocket, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    DisconnectReason,
    Browsers,
    BufferJSON
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const path = require('path');
const NodeCache = require('node-cache'); 

const app = express();
const PORT = process.env.PORT || 3001; 
const MONGO_URL = process.env.MONGO_URL; 

app.use(cors());
// 🚀 Increased limit to 60mb to allow large media uploads (Images/Videos)
app.use(express.json({ limit: '60mb' }));

// 📂 Serve Frontend from the 'docs' folder
app.use(express.static(path.join(__dirname, 'docs')));

// --- 🛠️ CUSTOM MONGODB AUTH (Stable) ---
// This handles the database connection manually to prevent "undefined" crashes
const initAuth = async (collection) => {
    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: id });
            if (data && data.value) {
                // Restore binary data from JSON
                return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
            }
            return null;
        } catch (error) { return null; }
    };

    const writeData = async (id, data) => {
        try {
            // Convert binary to JSON for storage
            const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
            await collection.updateOne({ _id: id }, { $set: { value } }, { upsert: true });
        } catch (error) { console.error('Error writing auth:', error); }
    };

    const removeData = async (id) => {
        try { await collection.deleteOne({ _id: id }); } catch (error) {}
    };

    const creds = await readData('creds') || (await import('@whiskeysockets/baileys')).initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value =  import('@whiskeysockets/baileys').then(m => m.proto.Message.AppStateSyncKeyData.fromObject(value));
                        }
                        if (value) data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) tasks.push(writeData(key, value)); else tasks.push(removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData('creds', creds)
    };
};

// 🧠 In-Memory Store (Fast RAM Access)
function makeInMemoryStore(id) {
    let state = { contacts: {}, chats: {} };
    return {
        get contacts() { return state.contacts; },
        get chats() { return state.chats; },
        bind: (ev) => {
            ev.on('contacts.upsert', (contacts) => contacts.forEach(c => state.contacts[c.id] = Object.assign(state.contacts[c.id] || {}, c)));
        }
    };
}

const sessions = {}; 
const msgRetryCounterCache = new NodeCache();

async function createSession(id) {
    try {
        console.log(`[${id}] Connecting to DB...`);
        const mongo = new MongoClient(MONGO_URL);
        await mongo.connect();
        const collection = mongo.db("whatsapp_bot").collection(`session_${id}`);

        const { state, saveCreds } = await initAuth(collection);
        const { version } = await fetchLatestBaileysVersion();
        const store = makeInMemoryStore(id);

        console.log(`[${id}] Starting Socket...`);

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.ubuntu("Chrome"), // Use Ubuntu browser to avoid 401 errors
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            msgRetryCounterCache, 
            generateHighQualityLinkPreview: true,
        });

        store.bind(sock.ev);
        sessions[id] = { sock, store, status: 'INITIALIZING', qr: null };

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessions[id].qr = qr;
                sessions[id].status = 'QR_READY';
            }
            if (connection === 'open') {
                console.log(`[${id}] 🟢 ONLINE`);
                sessions[id].status = 'READY';
                sessions[id].qr = null; 
            }
            if (connection === 'close') {
                const reason = (lastDisconnect?.error)?.output?.statusCode;
                console.log(`[${id}] 🔴 Closed: ${reason}`);
                const shouldReconnect = reason !== DisconnectReason.loggedOut && reason !== undefined;
                delete sessions[id];
                
                // Smart Reconnect Logic
                if (shouldReconnect) setTimeout(() => createSession(id), 3000); 
                else if (reason === undefined) setTimeout(() => createSession(id), 10000);
            }
        });
    } catch (err) { console.error(`[${id}] Error:`, err); }
}

// --- 🔌 API ENDPOINTS ---

// Serve the HTML file at the root URL
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'docs', 'index.html')); });

app.post('/api/start', (req, res) => { 
    const { id } = req.body;
    if (!sessions[id]) createSession(id);
    res.json({ success: true }); 
});

app.get('/api/status/:id', (req, res) => { 
    const s = sessions[req.params.id];
    res.json({ status: s ? s.status : 'OFFLINE', qr: s ? s.qr : null }); 
});

app.post('/api/logout', async (req, res) => { 
    const { id } = req.body;
    if (sessions[id]) {
        try { await sessions[id].sock.logout(); } catch(e){}
        delete sessions[id];
    }
    // Also clear DB
    try {
        const mongo = new MongoClient(MONGO_URL);
        await mongo.connect();
        await mongo.db("whatsapp_bot").collection(`session_${id}`).drop();
    } catch(e) {}
    res.json({ success: true }); 
});

// --- 🔥 MEDIA SENDING LOGIC ---
app.post('/api/send', async (req, res) => {
    const { id, number, message, file } = req.body;
    
    if (!sessions[id] || sessions[id].status !== 'READY') return res.status(400).json({ error: "Offline" });
    
    try {
        const jid = number + "@s.whatsapp.net";
        let payload;

        // If file exists, convert Base64 -> Buffer
        if (file && file.data) {
            const buffer = Buffer.from(file.data, 'base64');
            const mimetype = file.mimetype;

            if (mimetype.startsWith('image/')) {
                payload = { image: buffer, caption: message, mimetype: mimetype };
            } else if (mimetype.startsWith('video/')) {
                payload = { video: buffer, caption: message, mimetype: mimetype };
            } else if (mimetype.startsWith('audio/')) {
                 payload = { audio: buffer, mimetype: mimetype };
            } else {
                payload = { 
                    document: buffer, 
                    caption: message, 
                    mimetype: mimetype, 
                    fileName: file.filename || 'file.bin' 
                };
            }
        } else {
            payload = { text: message || "" };
        }

        await sessions[id].sock.sendMessage(jid, payload);
        res.json({ success: true });

    } catch (e) { 
        console.error("Send Error:", e);
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/api/contacts/:id', (req, res) => {
    if (!sessions[req.params.id]) return res.json({ count: 0, contacts: [] });
    // Filter & Format contacts for the frontend
    const contacts = Object.values(sessions[req.params.id].store.contacts)
        .filter(c => c.id.endsWith('@s.whatsapp.net'))
        .map(c => ({ 
            name: c.name || c.notify || c.verifiedName || "Unknown", 
            number: c.id.split('@')[0] 
        }));
    res.json({ success: true, count: contacts.length, contacts });
});

app.get('/api/groups/:id', (req, res) => {
    if (!sessions[req.params.id]) return res.json({ count: 0, groups: [] });
    const groups = Object.values(sessions[req.params.id].store.chats)
        .filter(c => c.id.endsWith('@g.us'))
        .map(c => ({ 
            id: c.id, 
            name: c.subject || 'Unknown', 
            count: c.participant?.length || 0 
        }));
    res.json({ success: true, count: groups.length, groups });
});

app.get('/api/get-members', async (req, res) => {
    try {
        const { id, groupJid } = req.query;
        if (!sessions[id]) return res.status(400).json({ error: "Offline" });
        const meta = await sessions[id].sock.groupMetadata(groupJid);
        const members = meta.participants.map(p => ({ number: p.id.split('@')[0] }));
        res.json({ count: members.length, members });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`🚀 Server running on Port ${PORT}`));
