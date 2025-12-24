/**
 * NEXUS CORE v2.2 | Data Layer
 * Connects UI to Supabase & Backend API
 */

// --- CONFIGURATION ---
const CONFIG = {
    API_BASE: "https://mkwhatsapp.onrender.com",
    // ⚠️ REPLACE WITH YOUR SUPABASE KEYS
    SUPABASE_URL: "https://upvprcemxefhviwptqnb.supabase.co",
    SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwdnByY2VteGVmaHZpd3B0cW5iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NTY5MzQsImV4cCI6MjA4MjEzMjkzNH0.yhaJUoNjflw0_cgjuk6HCFA7XIUiWTaG7tZBM4CfCGk" 
};

// Initialize Supabase Client
const { createClient } = supabase;
const db = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// --- 1. CLOUD DATABASE ADAPTER ---
const DataStore = {
    // Fetch all lists from Cloud
    async getLists() {
        const { data, error } = await db
            .from('lists')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (error) { console.error("DB Error:", error); return []; }
        
        // Format for UI compatibility
        return data.map(item => ({
            id: item.id,
            name: item.name,
            count: item.contacts.length,
            data: item.contacts
        }));
    },

    // Save a new list or Update existing
    async saveList(name, contacts) {
        // Check if list with this name exists to update it, or create new
        const { data: existing } = await db.from('lists').select('id').eq('name', name).single();

        if (existing) {
            await db.from('lists').update({ contacts }).eq('id', existing.id);
        } else {
            await db.from('lists').insert([{ name, contacts }]);
        }
        return true;
    },

    // Get specific list details
    async getListById(id) {
        const { data } = await db.from('lists').select('contacts').eq('id', id).single();
        return data ? data.contacts : [];
    },

    // Delete a list
    async deleteList(id) {
        await db.from('lists').delete().eq('id', id);
        return true;
    }
};

// --- 2. BACKEND API ADAPTER ---
const Api = {
    async req(endpoint, body) {
        try {
            const r = await fetch(`${CONFIG.API_BASE}/api/${endpoint}`, body ? {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            } : {});
            return r.ok ? await r.json() : null;
        } catch (e) { return null; }
    }
};

// --- 3. EXPORT HELPERS ---
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
    }
};
