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

const app = express();
const PORT = process.env.PORT || 3001; 
const MONGO_URL = process.env.MONGO_URL; 

app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.static(path.join(__dirname, 'docs'))); // Serving from 'docs'

// --- 🛠️ CUSTOM MONGODB AUTH (The Fix) ---
// We write this manually to ensure it works with the latest Baileys
const initAuth = async (collection) => {
    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: id });
            if (data && data.value) {
                // Deserialize the JSON back into Buffers
                return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
            }
            return null;
        } catch (error) { return null; }
    };

    const writeData = async (id, data) => {
        try {
            // Serialize Buffers to JSON to save safely in Mongo
            const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
            await collection.updateOne(
                { _id: id },
                { $set: { value } },
                { upsert: true }
            );
        } catch (error) { console.error('Error writing auth:', error); }
    };

    const removeData = async (id) => {
        try { await collection.deleteOne({ _id: id }); } 
        catch (error) { console.error('Error removing auth:', error); }
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
                            if (value) tasks.push(writeData(key, value));
                            else tasks.push(removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData('creds', creds)
    };
};
// ------------------------------------------

// In-Memory Store for contacts/chats
function makeInMemoryStore(id) {
    let state = { contacts: {}, chats: {} };
    return {
        get contacts() { return state.contacts; },
        get chats() { return state.chats; },
        bind: (ev) => {
            ev.on('contacts.upsert', (contacts) => {
                contacts.forEach(c => state.contacts[c.id] = Object.assign(state.contacts[c.id] || {}, c));
            });
        }
    };
}

const sessions = {}; 

async function createSession(id) {
    try {
        console.log(`[${id}] Connecting to DB...`);
        const mongo = new MongoClient(MONGO_URL);
        await mongo.connect();
        
        // Create a specific collection for this session ID
        const collection = mongo.db("whatsapp_bot").collection(`session_${id}`);

        // Use our CUSTOM Auth
        const { state, saveCreds } = await initAuth(collection);
        const { version } = await fetchLatestBaileysVersion();
        const store = makeInMemoryStore(id);

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
            // Important: Fixes some retry loops
            msgRetryCounterCache: new (require('node-cache'))(), 
            generateHighQualityLinkPreview: true,
        });

        store.bind(sock.ev);
        sessions[id] = { sock, store, status: 'INITIALIZING', qr: null };

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

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
                const reason = (lastDisconnect?.error)?.output?.statusCode;
                console.log(`[${id}] 🔴 Closed: ${reason}`);

                // Prevent infinite loop if "undefined" error occurs
                const shouldReconnect = reason !== DisconnectReason.loggedOut && reason !== undefined;
                
                delete sessions[id];

                if (shouldReconnect) {
                    setTimeout(() => createSession(id), 3000); // 3s cool-down
                } else {
                    console.log(`[${id}] ⚠️ Fatal error or Logged out. Not reconnecting.`);
                    // If it was undefined, we try ONE more time after a long delay, just in case
                    if (reason === undefined) setTimeout(() => createSession(id), 10000);
                }
            }
        });

    } catch (err) {
        console.error(`[${id}] Failed to create session:`, err);
    }
}

// --- ROUTES ---
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
    const mongo = new MongoClient(MONGO_URL);
    await mongo.connect();
    await mongo.db("whatsapp_bot").collection(`session_${id}`).drop();
    res.json({ success: true }); 
});

app.post('/api/send', async (req, res) => {
    const { id, number, message } = req.body;
    if (!sessions[id] || sessions[id].status !== 'READY') return res.status(400).json({ error: "Offline" });
    try {
        await sessions[id].sock.sendMessage(number + "@s.whatsapp.net", { text: message });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/contacts/:id', (req, res) => {
    if (!sessions[req.params.id]) return res.json({ count: 0, contacts: [] });
    const contacts = Object.values(sessions[req.params.id].store.contacts).map(c => ({ 
        name: c.name || c.notify, 
        number: c.id.split('@')[0] 
    }));
    res.json({ success: true, count: contacts.length, contacts });
});

app.listen(PORT, () => console.log(`🚀 Server running on Port ${PORT}`));
