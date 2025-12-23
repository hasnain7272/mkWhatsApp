const { 
    default: makeWASocket, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const { MongoClient } = require('mongodb');
const { useMongoDBAuthState } = require('mongo-baileys');
const http = require('http');

// 1. SETUP: Put your connection string here
// In a real project, use process.env.MONGO_URL for security
const MONGO_URL = "mongodb+srv://admin:YOUR_PASSWORD@cluster0.example.mongodb.net/?retryWrites=true&w=majority";

async function startWhatsApp() {
    // 2. CONNECT TO DATABASE
    const mongo = new MongoClient(MONGO_URL, { socketTimeoutMS: 100000 });
    await mongo.connect();
    
    // This creates a collection called 'auth_info' in your DB
    const collection = mongo.db("whatsapp_bot").collection("auth_info");

    // 3. LOAD SESSION FROM DB
    const { state, saveCreds } = await useMongoDBAuthState(collection);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if(shouldReconnect) startWhatsApp();
        } else if(connection === 'open') {
            console.log('✅ Connected! Session is saved to MongoDB.');
        }
    });

    // Simple Test Command
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            const msg = messages[0];
            if (!msg.message) return;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            
            if (text === '!ping') {
                await sock.sendMessage(msg.key.remoteJid, { text: 'Pong! 🏓' });
            }
        }
    });
}

// 4. KEEP ALIVE (For Render/Koyeb)
http.createServer((req, res) => res.end('Bot is Alive')).listen(process.env.PORT || 8080);

startWhatsApp();
