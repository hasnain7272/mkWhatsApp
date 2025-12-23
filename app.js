const { 
    default: makeWASocket, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const express = require('express');
const cors = require('cors'); // <--- NEW: Allows Frontend access
const { MongoClient } = require('mongodb');
const { useMongoDBAuthState } = require('mongo-baileys');
const path = require('path');

const app = express();
// Use Render's port or default to 3001 (to avoid conflict with React's 3000)
const PORT = process.env.PORT || 3001; 

// --- CONFIGURATION ---
// Add this URL in your Render "Environment Variables" settings as MONGO_URL
const MONGO_URL = process.env.MONGO_URL || "mongodb+srv://YOUR_MONGO_URL_HERE"; 

app.use(cors()); // Allow all connections (Great for testing)
app.use(express.json({ limit: '60mb' }));

app.use(express.static(path.join(__dirname, 'docs')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global Map to hold active sessions
const sessions = {}; 

// --- 🧠 IN-MEMORY STORE (RAM) ---
// We use RAM for contacts/chats on Cloud (faster & cheaper than writing to disk repeatedly)
function makeInMemoryStore(id) {
    let state = { contacts: {}, chats: {} };

    return {
        get contacts() { return state.contacts; },
        get chats() { return state.chats; },
        bind: (ev) => {
            ev.on('messaging-history.set', ({ contacts, chats }) => {
                contacts.forEach(c => state.contacts[c.id] = Object.assign(state.contacts[c.id] || {}, c));
                chats.forEach(c => state.chats[c.id] = Object.assign(state.chats[c.id] || {}, c));
                console.log(`[${id}] 📥 Synced ${contacts.length} contacts.`);
            });

            ev.on('contacts.upsert', (contacts) => {
                contacts.forEach(c => state.contacts[c.id] = Object.assign(state.contacts[c.id] || {}, c));
            });
            
            ev.on('contacts.update', (updates) => {
                updates.forEach(u => {
                    if(state.contacts[u.id]) Object.assign(state.contacts[u.id], u);
                });
            });
        },
        loadMessage: async () => undefined
    };
}

// --- ⚙️ SESSION ENGINE ---
async function createSession(id) {
    try {
        console.log(`[${id}] Starting session...`);
        
        // 1. Connect to MongoDB (The "Vault")
        const mongo = new MongoClient(MONGO_URL);
        await mongo.connect();
        const collection = mongo.db("whatsapp_bot").collection(`auth_${id}`);

        // 2. Load Auth State from DB
        const { state, saveCreds } = await useMongoDBAuthState(collection);
        const { version } = await fetchLatestBaileysVersion();
        
        // 3. Create Store (In-Memory)
        const store = makeInMemoryStore(id);

        // 4. Create Socket
        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false, // Useful for logs
            browser: Browsers.ubuntu("Chrome"),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            generateHighQualityLinkPreview: true,
            syncFullHistory: false, // Turn off to save RAM on free tier
        });

        // Bind Store
        store.bind(sock.ev);

        // Initialize Session Data
        sessions[id] = { sock, store, status: 'INITIALIZING', qr: null };

        // 5. Handle Events
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Update QR for Frontend
            if (qr) {
                console.log(`[${id}] QR GENERATED`);
                sessions[id].qr = qr;
                sessions[id].status = 'QR_READY';
            }

            if (connection === 'open') {
                console.log(`[${id}] 🟢 ONLINE`);
                sessions[id].status = 'READY';
                sessions[id].qr = null; 
            }

            if (connection === 'close') {
                const code = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = code !== DisconnectReason.loggedOut;
                console.log(`[${id}] 🔴 Connection closed (${code}). Reconnecting: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    createSession(id); 
                } else {
                    delete sessions[id]; // Clear session if logged out
                }
            }
        });

    } catch (err) {
        console.error(`[${id}] Failed to create session:`, err);
    }
}

// --- 🔌 API ENDPOINTS ---

// 1. Start Session
app.post('/api/start', (req, res) => { 
    const { id } = req.body;
    if (!sessions[id]) createSession(id);
    res.json({ success: true, message: "Session starting..." }); 
});

// 2. Get Status & QR (Frontend Polls This)
app.get('/api/status/:id', (req, res) => { 
    const s = sessions[req.params.id];
    if (!s) return res.json({ status: 'OFFLINE', qr: null });
    res.json({ status: s.status, qr: s.qr }); 
});

// 3. Logout
app.post('/api/logout', async (req, res) => { 
    const { id } = req.body;
    if (sessions[id]) {
        try { await sessions[id].sock.logout(); } catch(e){}
        delete sessions[id];
        // Note: In Mongo, you might want to drop the collection here to fully clear data
    }
    res.json({ success: true }); 
});

// 4. Send Message
app.post('/api/send', async (req, res) => {
    const { id, number, message } = req.body;
    if (!sessions[id] || sessions[id].status !== 'READY') {
        return res.status(400).json({ error: "Session offline or not ready" });
    }
    try {
        const jid = number + "@s.whatsapp.net";
        await sessions[id].sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. Get Contacts
app.get('/api/contacts/:id', (req, res) => {
    if (!sessions[req.params.id]) return res.json({ count: 0, contacts: [] });
    const contacts = Object.values(sessions[req.params.id].store.contacts)
        .filter(c => c.name || c.notify)
        .map(c => ({ name: c.name || c.notify, number: c.id.split('@')[0] }));
    res.json({ success: true, count: contacts.length, contacts });
});

// Start Server
app.listen(PORT, () => console.log(`🚀 Server running on Port ${PORT}`));
