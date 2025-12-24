/**
 * NEXUS CORE v2.0
 * Data Layer & Business Logic
 */

const CONFIG = {
    API_BASE: "https://mkwhatsapp.onrender.com",
    // Future Supabase Config
    SUPABASE_URL: "", 
    SUPABASE_KEY: ""
};

// --- 1. DATA STORE ADAPTER (Repository Pattern) ---
// Currently uses localStorage. Ready to swap for Supabase.
const DataStore = {
    async getLists() {
        // Future: await supabase.from('lists').select('*')
        const lists = [];
        Object.keys(localStorage).forEach(k => {
            if(k.startsWith('nexus_list_')) {
                try {
                    const content = JSON.parse(localStorage.getItem(k));
                    lists.push({ id: k, name: k.replace('nexus_list_', ''), count: content.length, data: content });
                } catch(e) {}
            }
        });
        return lists;
    },

    async saveList(name, contacts) {
        // Future: await supabase.from('lists').insert({ name, contacts })
        localStorage.setItem(`nexus_list_${name}`, JSON.stringify(contacts));
        return true;
    },

    async deleteList(id) {
        // Future: await supabase.from('lists').delete().eq('id', id)
        localStorage.removeItem(id);
        return true;
    },

    async getHistory() {
        return JSON.parse(localStorage.getItem('nexus_history') || '[]');
    },

    async addHistory(entry) {
        const hist = await this.getHistory();
        hist.unshift(entry);
        localStorage.setItem('nexus_history', JSON.stringify(hist.slice(0, 50)));
    }
};

// --- 2. API CLIENT ---
const Api = {
    async request(endpoint, body) {
        try {
            const res = await fetch(`${CONFIG.API_BASE}/api/${endpoint}`, body ? {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            } : {});
            return res.ok ? await res.json() : null;
        } catch (e) {
            console.error("API Error:", e);
            return null;
        }
    }
};

// --- 3. BUSINESS LOGIC MODULES ---
const Nexus = {
    state: {
        user: 'client-1',
        queue: [],
        processed: 0,
        isRunning: false,
        allContacts: [], // Global Memory
        selection: new Set(),
        activeFile: null
    },

    // Session Management
    Session: {
        async check() {
            const res = await Api.request(`status/${Nexus.state.user}`);
            return res || { status: 'OFFLINE' };
        },
        async start() { await Api.request('start', { id: Nexus.state.user }); },
        async stop() { await Api.request('logout', { id: Nexus.state.user }); }
    },

    // Contact Logic
    Contacts: {
        async sync() {
            const res = await Api.request(`contacts/${Nexus.state.user}`);
            if (res && res.contacts) {
                // Deduplication Logic
                const existing = new Set(Nexus.state.allContacts.map(c => c.number));
                res.contacts.forEach(c => {
                    if (!existing.has(c.number)) Nexus.state.allContacts.push(c);
                });
                return Nexus.state.allContacts.length;
            }
            return 0;
        },
        search(query) {
            const q = query.toLowerCase();
            return Nexus.state.allContacts.filter(c => 
                (c.name || '').toLowerCase().includes(q) || c.number.includes(q)
            );
        }
    },

    // Engine Logic
    Engine: {
        addToQueue(numbers, message) {
            const newItems = numbers.map(n => ({
                number: n,
                msg: message,
                file: Nexus.state.activeFile,
                // Name lookup
                name: Nexus.state.allContacts.find(c => c.number === n)?.name || "Unknown"
            }));
            Nexus.state.queue.push(...newItems);
            return newItems.length;
        },
        
        async processNext(onLog) {
            if (!Nexus.state.isRunning || Nexus.state.queue.length === 0) return false;
            
            const item = Nexus.state.queue.shift();
            onLog(`> Sending to ${item.name}...`, 'info');
            
            try {
                await Api.request('send', { 
                    id: Nexus.state.user, 
                    number: item.number, 
                    message: item.msg, 
                    file: item.file 
                });
                onLog(`> SENT: ${item.number}`, 'success');
                Nexus.state.processed++;
                return true; // Success
            } catch(e) {
                onLog(`> FAILED: ${item.number}`, 'error');
                return true; // Handled
            }
        }
    },

    // File Handler
    Utils: {
        async processFile(file) {
            // HEIC conversion logic
            if (file.name.toLowerCase().endsWith('.heic') && window.heic2any) {
                try {
                    const blob = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.7 });
                    file = new File([Array.isArray(blob)?blob[0]:blob], file.name.replace(/\.heic$/i, ".jpg"), { type: "image/jpeg" });
                } catch(e) {}
            }
            return new Promise(resolve => {
                const reader = new FileReader();
                reader.readAsDataURL(file);
                reader.onload = () => resolve({ mimetype: file.type, data: reader.result.split(',')[1], filename: file.name });
            });
        }
    }
};

// Export to Window
window.Nexus = Nexus;
window.DataStore = DataStore;
