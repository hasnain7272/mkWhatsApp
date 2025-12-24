/**
 * NEXUS CORE v4.0 | Command Center Engine
 * Focused on Database-First Execution and Reusability
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
    // --- 1. LISTS (Standard) ---
    async getLists() {
        const { data } = await db.from('lists').select('id, name, contacts').order('created_at', { ascending: false });
        return (data || []).map(i => ({ id: i.id, name: i.name, count: i.contacts ? i.contacts.length : 0 }));
    },
    async getListContent(id) {
        const { data } = await db.from('lists').select('name, contacts').eq('id', id).single();
        return data || { name: '', contacts: [] }; 
    },
    async saveList(name, contacts) {
        const { data: existing } = await db.from('lists').select('id').eq('name', name).single();
        if (existing) await db.from('lists').update({ contacts }).eq('id', existing.id);
        else await db.from('lists').insert([{ name, contacts }]);
    },
    async deleteList(id) { await db.from('lists').delete().eq('id', id); },

    // --- 2. COMMAND CENTER (Campaigns) ---
    
    // Create & Offload to Cloud immediately (Low RAM)
    async createCampaign(name, message, contactList, mediaFile) {
        let mediaData = null, mediaMime = null;
        if(mediaFile) { mediaData = mediaFile.data; mediaMime = mediaFile.mimetype; }

        // A. Create Parent Record
        const { data: camp, error } = await db.from('campaigns').insert([{
            name: name, message: message, total_count: contactList.length, status: 'ready',
            media_data: mediaData, media_mime: mediaMime
        }]).select().single();
        
        if(error) return null;

        // B. Bulk Insert Queue (Chunked for Network Stability)
        const queueItems = contactList.map(c => ({
            campaign_id: camp.id,
            number: c.number,
            name: c.name,
            status: 'pending'
        }));

        const chunkSize = 500; // Smaller chunks for reliability
        for (let i = 0; i < queueItems.length; i += chunkSize) {
            await db.from('queue').insert(queueItems.slice(i, i + chunkSize));
        }

        return camp.id;
    },

    // Fetch History for Dashboard/Campaign Tab
    async getCampaignHistory() {
        const { data } = await db.from('campaigns')
            .select('id, name, status, sent_count, failed_count, total_count, created_at, message, media_mime')
            .order('created_at', { ascending: false })
            .limit(10);
        return data || [];
    },

    // Fetch Full Details for "Reuse" functionality
    async getCampaignForReuse(id) {
        const { data } = await db.from('campaigns').select('*').eq('id', id).single();
        return data;
    },

    // --- 3. ENGINE EXECUTION (Row-by-Row) ---
    
    async fetchNextJob(campaignId) {
        const { data } = await db.from('queue')
            .select('*')
            .eq('campaign_id', campaignId)
            .eq('status', 'pending')
            .limit(1)
            .maybeSingle();
        return data;
    },

    async completeJob(id, status) {
        await db.from('queue').update({ status: status, updated_at: new Date() }).eq('id', id);
    },

    async updateStats(campId, type) {
        // Atomic increment using RPC would be better, but read-update-write works for single-agent
        const { data } = await db.from('campaigns').select('sent_count, failed_count').eq('id', campId).single();
        const update = type === 'sent' ? { sent_count: data.sent_count + 1 } : { failed_count: data.failed_count + 1 };
        await db.from('campaigns').update(update).eq('id', campId);
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
            try { file = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.7 }); } catch(e){}
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
