/**
 * NEXUS CORE v2.4 | Fixed Update Logic
 * Handles Supabase Data & Business Logic
 */

const CONFIG = {
    API_BASE: "https://mkwhatsapp.onrender.com",
    // ⚠️ PASTE YOUR SUPABASE KEYS HERE
    SUPABASE_URL: "https://upvprcemxefhviwptqnb.supabase.co",
    SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwdnByY2VteGVmaHZpd3B0cW5iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NTY5MzQsImV4cCI6MjA4MjEzMjkzNH0.yhaJUoNjflw0_cgjuk6HCFA7XIUiWTaG7tZBM4CfCGk" 
};

const { createClient } = supabase;
const db = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const DataStore = {
    // 1. Get All Lists (Headers only)
    async getLists() {
        const { data, error } = await db.from('lists').select('id, name, contacts').order('created_at', { ascending: false });
        if (error) return [];
        return data.map(i => ({ id: i.id, name: i.name, count: i.contacts ? i.contacts.length : 0 }));
    },

    // 2. Get Single List (Name + Contacts) - FIXED
    async getListContent(id) {
        const { data } = await db.from('lists').select('name, contacts').eq('id', id).single();
        // Return object with name to populate UI input
        return data || { name: '', contacts: [] }; 
    },

    // 3. Save Logic (Smart Upsert)
    async saveList(name, contacts) {
        // Check if list exists by Name
        const { data: existing } = await db.from('lists').select('id').eq('name', name).single();
        
        if (existing) {
            // UPDATE existing
            await db.from('lists').update({ contacts }).eq('id', existing.id);
        } else {
            // INSERT new
            await db.from('lists').insert([{ name, contacts }]);
        }
        return true;
    },

    async deleteList(id) {
        await db.from('lists').delete().eq('id', id);
        return true;
    }
};

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

const CoreUtils = {
    async processFile(file) {
        if (file.name.toLowerCase().endsWith('.heic') && window.heic2any) {
            try { file = await heic2any({ blob: file, toType: "image/jpeg" }); } catch(e){}
        }
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => resolve({ mimetype: file.type, data: reader.result.split(',')[1], filename: file.name });
        });
    },
    exportCSV(name, dataPromise) {
        // Handles both direct data and promises (async fetching)
        Promise.resolve(dataPromise).then(result => {
            // If result has .contacts (from getListContent), use that. Otherwise assume result IS the array.
            const data = result.contacts || result; 
            const csvContent = "data:text/csv;charset=utf-8," + "Name,Number\n" + data.map(e => `${e.name},${e.number}`).join("\n");
            const link = document.createElement("a");
            link.setAttribute("href", encodeURI(csvContent));
            link.setAttribute("download", `${name}.csv`);
            document.body.appendChild(link); link.click(); document.body.removeChild(link);
        });
    }
};
