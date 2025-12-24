/**
 * NEXUS CORE v2.5 | Hybrid Architecture
 * RAM Execution + DB Reporting
 */

const CONFIG = {
    API_BASE: "https://mkwhatsapp.onrender.com",
    SUPABASE_URL: "https://upvprcemxefhviwptqnb.supabase.co",
    SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwdnByY2VteGVmaHZpd3B0cW5iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NTY5MzQsImV4cCI6MjA4MjEzMjkzNH0.yhaJUoNjflw0_cgjuk6HCFA7XIUiWTaG7tZBM4CfCGk" 
};

// Initialize Supabase
const { createClient } = supabase;
const db = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const DataStore = {
    // --- LISTS (Existing Logic) ---
    async getLists() {
        const { data, error } = await db.from('lists').select('id, name, contacts').order('created_at', { ascending: false });
        if (error) return [];
        return data.map(i => ({ id: i.id, name: i.name, count: i.contacts ? i.contacts.length : 0 }));
    },
    async getListContent(id) {
        const { data } = await db.from('lists').select('name, contacts').eq('id', id).single();
        return data || { name: '', contacts: [] }; 
    },
    async saveList(name, contacts) {
        const { data: existing } = await db.from('lists').select('id').eq('name', name).maybeSingle();
        if (existing) await db.from('lists').update({ contacts }).eq('id', existing.id);
        else await db.from('lists').insert([{ name, contacts }]);
    },
    async deleteList(id) { await db.from('lists').delete().eq('id', id); },

    // --- CAMPAIGNS (New Hybrid Logic) ---
    async createCampaign(name, msg, total, mediaFile) {
        let mData = null, mMime = null, mName = null;
        if(mediaFile) { mData = mediaFile.data; mMime = mediaFile.mimetype; mName = mediaFile.filename; }
        
        const { data, error } = await db.from('campaigns').insert([{
            name: name,
            message: msg,
            total_count: total,
            sent_count: 0,
            status: 'running',
            media_data: mData,
            media_mime: mMime,
            media_name: mName
        }]).select().single();
        
        if(error) { console.error("DB Error:", error); return null; }
        return data.id;
    },

    // Light weight update - increments counters
    async incrementStats(id, type) {
        // We fetch first to increment accurately (Simple approach)
        // Ideally we use an RPC function, but this is easier to deploy without SQL knowledge
        const { data } = await db.from('campaigns').select(`${type}_count`).eq('id', id).single();
        if(data) {
            const update = {};
            update[`${type}_count`] = data[`${type}_count`] + 1;
            await db.from('campaigns').update(update).eq('id', id);
        }
    },

    async getCampaigns() {
        const { data } = await db.from('campaigns').select('*').order('created_at', { ascending: false }).limit(10);
        return data || [];
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
        Promise.resolve(dataPromise).then(result => {
            const data = result.contacts || result; 
            const csvContent = "data:text/csv;charset=utf-8," + "Name,Number\n" + data.map(e => `${e.name},${e.number}`).join("\n");
            const link = document.createElement("a");
            link.setAttribute("href", encodeURI(csvContent));
            link.setAttribute("download", `${name}.csv`);
            document.body.appendChild(link); link.click(); document.body.removeChild(link);
        });
    }
};
