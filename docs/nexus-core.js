/**
 * NEXUS CORE v2.6 | Hybrid Architecture with History
 * RAM Execution + DB Reporting + Table Management
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
    // --- LISTS ---
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

    // --- CAMPAIGNS ---
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

    // NEW: Bulk insert into Queue Table (Persistence)
    async addToQueue(campId, numbers) {
        // Supabase allows bulk inserts. We map numbers to row objects.
        const rows = numbers.map(n => ({ campaign_id: campId, number: n, status: 'pending' }));
        // Insert in chunks of 500 to prevent packet size errors if list is huge
        const chunkSize = 500;
        for (let i = 0; i < rows.length; i += chunkSize) {
            await db.from('campaign_queue').insert(rows.slice(i, i + chunkSize));
        }
    },

    // NEW: Fetch a "Batch" of pending items
    async getNextBatch(campId, size) {
        const { data } = await db.from('campaign_queue')
            .select('id, number')
            .eq('campaign_id', campId)
            .eq('status', 'pending')
            .limit(size); // Respects the "Batch Size" setting
        return data || [];
    },

    // NEW: Mark individual item as sent/failed
    async updateQueueStatus(itemId, status) {
        await db.from('campaign_queue').update({ status }).eq('id', itemId);
    },

    // NEW: Check for interrupted campaigns on boot
    async getRunningCampaign() {
        const { data } = await db.from('campaigns')
            .select('*')
            .eq('status', 'running')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
        return data;
    },

    async incrementStats(id, type) {
        // Simple increment logic
        const { data } = await db.from('campaigns').select(`${type}_count`).eq('id', id).single();
        if(data) {
            const update = {};
            update[`${type}_count`] = data[`${type}_count`] + 1;
            await db.from('campaigns').update(update).eq('id', id);
        }
    },

    async getCampaigns() {
        // Fetches meaningful rows for the History Table
        const { data } = await db.from('campaigns')
            .select('id, name, created_at, sent_count, total_count, status, message, media_name')
            .order('created_at', { ascending: false })
            .limit(20);
        return data || [];
    },

    async getCampaignFull(id) {
        // Fetches the heavy media data only on demand
        const { data } = await db.from('campaigns').select('*').eq('id', id).single();
        return data;
    },

    async updateStatus(id, status) {
        await db.from('campaigns').update({ status }).eq('id', id);
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
            try { file = await heic2any({ blob: file, toType: "image/jpeg", quality: 1.0 }); } catch(e){}
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
