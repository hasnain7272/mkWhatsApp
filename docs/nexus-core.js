/**
 * NEXUS CORE v2.3 | Enterprise Data Layer
 * Handles Supabase, Logic, and File Processing
 */

// --- CONFIGURATION ---
const CONFIG = {
    API_BASE: "https://mkwhatsapp.onrender.com",
    // ⚠️ REPLACE WITH YOUR SUPABASE KEYS
    SUPABASE_URL: "https://upvprcemxefhviwptqnb.supabase.co",
    SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwdnByY2VteGVmaHZpd3B0cW5iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NTY5MzQsImV4cCI6MjA4MjEzMjkzNH0.yhaJUoNjflw0_cgjuk6HCFA7XIUiWTaG7tZBM4CfCGk" 
};

// Initialize Supabase
const { createClient } = supabase;
const db = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// --- 1. CLOUD DATA STORE ---
const DataStore = {
    // Fetch all lists with metadata
    async getLists() {
        const { data, error } = await db.from('lists').select('*').order('created_at', { ascending: false });
        if (error) { console.error(error); return []; }
        return data.map(i => ({ id: i.id, name: i.name, count: i.contacts ? i.contacts.length : 0 }));
    },

    // Get full content of a specific list
    async getListContent(id) {
        const { data } = await db.from('lists').select('contacts').eq('id', id).single();
        return data ? data.contacts : [];
    },

    // Upsert (Create or Update)
    async saveList(name, contacts) {
        // Check existence by name to allow "Overwriting" by name
        const { data: existing } = await db.from('lists').select('id').eq('name', name).single();
        
        if (existing) {
            await db.from('lists').update({ contacts, created_at: new Date() }).eq('id', existing.id);
        } else {
            await db.from('lists').insert([{ name, contacts }]);
        }
        return true;
    },

    async deleteList(id) {
        await db.from('lists').delete().eq('id', id);
        return true;
    }
};

// --- 2. API ADAPTER ---
const Api = {
    async req(endpoint, body) {
        try {
            const r = await fetch(`${CONFIG.API_BASE}/api/${endpoint}`, body ? {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            } : {});
            return r.ok ? await r.json() : null;
        } catch (e) { return null; }
    }
};

// --- 3. UTILITIES ---
const CoreUtils = {
    async processFile(file) {
        // HEIC Support
        if (file.name.toLowerCase().endsWith('.heic') && window.heic2any) {
            try { 
                const blob = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.7 });
                file = new File([Array.isArray(blob)?blob[0]:blob], file.name.replace(/\.heic$/i, ".jpg"), { type: "image/jpeg" });
            } catch(e) { console.error("HEIC Error", e); }
        }
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => resolve({ mimetype: file.type, data: reader.result.split(',')[1], filename: file.name });
        });
    },

    exportCSV(name, data) {
        const csvContent = "data:text/csv;charset=utf-8," + "Name,Number\n" + data.map(e => `${e.name},${e.number}`).join("\n");
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `${name}.csv`);
        document.body.appendChild(link); link.click(); document.body.removeChild(link);
    }
};
