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
app.use(express.json({ limit: '60mb' }));
app.use(express.static(path.join(__dirname, 'docs')));

// --- 🛠️ 1. AUTH HANDLER (Saves Login Keys) ---
const initAuth = async (collection) => {
    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: id });
            if (data && data.value) return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
            return null;
        } catch (error) { return null; }
    };

    const writeData = async (id, data) => {
        try {
            const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
            await collection.updateOne({ _id: id }, { $set: { value } }, { upsert: true });
        } catch (error) { console.error('Auth Write Error:', error); }
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

// --- 💾 2. PERSISTENT STORE (Saves Contacts to DB) ---
const makePersistentStore = async (id, mongoClient) => {
    // We use a separate collection for contacts to keep things organized
    const contactsCol = mongoClient.db("whatsapp_bot").collection(`contacts_${id}`);
    
    let state = { contacts: {}, chats: {} };

    // A. Load contacts from DB at startup
    console.log(`[${id}] 📥 Loading contacts from DB...`);
    try {
        const docs = await contactsCol.find({}).toArray();
        if (docs.length > 0) {
            docs.forEach(c => state.contacts[c._id] = c);
            console.log(`[${id}] ✅ Restored ${docs.length} contacts from DB.`);
        } else {
            console.log(`[${id}] ℹ️ No contacts in DB. Waiting for scan...`);
        }
    } catch (e) { console.error(`[${id}] DB Load Error:`, e); }

    // Helper to bulk save contacts
    const saveToDb = async (contacts) => {
        if (!contacts.length) return;
        const ops = contacts.map(c => ({
            updateOne: {
                filter: { _id: c.id },
                update: { $set: Object.assign({ _id: c.id }, c) }, // Ensure _id is set
                upsert: true
            }
        }));
        try { await contactsCol.bulkWrite(ops); } catch (e) { console.error('Contact Write Error:', e); }
    };

    return {
        get contacts() { return state.contacts; },
        get chats() { return state.chats; },
        bind: (ev) => {
            // B. Listen for the massive history sync (First Scan)
            ev.on('messaging-history.set', async ({ contacts }) => {
                console.log(`[${id}] 🔄 History Sync: ${contacts.length} contacts. Saving...`);
                // Update RAM
                contacts.forEach(c => state.contacts[c.id] = Object.assign(state.contacts[c.id] || {}, c));
                // Update DB
                await saveToDb(contacts);
            });

            // C. Listen for new contacts / updates
            ev.on('contacts.upsert', async (contacts) => {
                contacts.forEach(c => state.contacts[c.id] = Object.assign(state.contacts[c.id] || {}, c));
                await saveToDb(contacts);
            });
            
            // D. Listen for contact name updates
            ev.on('contacts.update', async (updates) => {
                const updatedContacts = [];
                updates.forEach(u => {
                    if (state.contacts[u.id]) {
                        Object.assign(state.contacts[u.id], u);
                        updatedContacts.push(state.contacts[u.id]);
                    }
                });
                await saveToDb(updatedContacts);
            });
        }
    };
};

const sessions = {}; 
const msgRetryCounterCache = new NodeCache();

async function createSession(id) {
    try {
        console.log(`[${id}] Connecting to DB...`);
        const mongo = new MongoClient(MONGO_URL);
        await mongo.connect();
        
        const authCol = mongo.db("whatsapp_bot").collection(`session_${id}`);
        const { state, saveCreds } = await initAuth(authCol);
        
        const { version } = await fetchLatestBaileysVersion();
        
        // 🔥 Use Persistent Store instead of Memory Store
        const store = await makePersistentStore(id, mongo);

        console.log(`[${id}] Starting Socket...`);

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.ubuntu("Chrome"),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            msgRetryCounterCache, 
            generateHighQualityLinkPreview: true,
            // Optimization: Don't wait for full history if we already have data, 
            // but for first run with this code, we want it.
            syncFullHistory: true 
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
                
                if (shouldReconnect) setTimeout(() => createSession(id), 3000); 
                else if (reason === undefined) setTimeout(() => createSession(id), 10000);
            }
        });
    } catch (err) { console.error(`[${id}] Error:`, err); }
}

// --- API ROUTES ---

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

// 🔥 Logout Route (Use this to force a re-scan)
app.post('/api/logout', async (req, res) => { 
    const { id } = req.body;
    if (sessions[id]) {
        try { await sessions[id].sock.logout(); } catch(e){}
        delete sessions[id];
    }
    // Note: We do NOT delete the contacts collection here, so data persists.
    // If you WANT to wipe contacts, uncomment the next line:
    // await new MongoClient(MONGO_URL).connect().then(m => m.db("whatsapp_bot").collection(`contacts_${id}`).drop());
    
    // We DO wipe the session keys so you can scan again
    const mongo = new MongoClient(MONGO_URL);
    await mongo.connect();
    await mongo.db("whatsapp_bot").collection(`session_${id}`).drop();
    
    res.json({ success: true }); 
});

app.post('/api/send', async (req, res) => {
    const { id, number, message, file } = req.body;
    if (!sessions[id] || sessions[id].status !== 'READY') return res.status(400).json({ error: "Offline" });
    try {
        const jid = number + "@s.whatsapp.net";
        let payload;
        if (file && file.data) {
            const buffer = Buffer.from(file.data, 'base64');
            const mimetype = file.mimetype;
            if (mimetype.startsWith('image/')) payload = { image: buffer, caption: message, mimetype: mimetype };
            else if (mimetype.startsWith('video/')) payload = { video: buffer, caption: message, mimetype: mimetype };
            else if (mimetype.startsWith('audio/')) payload = { audio: buffer, mimetype: mimetype };
            else payload = { document: buffer, caption: message, mimetype: mimetype, fileName: file.filename || 'file.bin' };
        } else {
            payload = { text: message || "" };
        }
        await sessions[id].sock.sendMessage(jid, payload);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/contacts/:id', (req, res) => {
    if (!sessions[req.params.id]) return res.json({ count: 0, contacts: [] });
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
        .map(c => ({ id: c.id, name: c.subject || 'Unknown', count: c.participant?.length || 0 }));
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

app.get('/api/init', (req, res) => {
    // Security Check: Ensure keys exist on server before sending
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
        return res.status(500).json({ error: 'Server Environment Not Configured' });
    }

    res.json({
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_KEY: process.env.SUPABASE_KEY,
        // Optional: Send the API Base URL dynamically too
        API_BASE: process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'
    });
});

app.listen(PORT, () => console.log(`🚀 Server running on Port ${PORT}`));
