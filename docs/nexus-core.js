
/**
 * NEXUS CORE v3.1 | DB-Driven Engine (Low RAM)
 * Features: Base64 Media Storage, Row-by-Row Processing
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
    // --- LISTS ---
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

    // --- CAMPAIGNS (The Heavy Lifters) ---
    
    // 1. Create Campaign (Stores Media in DB)
    async createCampaign(name, message, contactList, mediaFile) {
        // Prepare Media
        let mediaData = null, mediaMime = null;
        if(mediaFile) {
            mediaData = mediaFile.data; // Base64 string from CoreUtils
            mediaMime = mediaFile.mimetype;
        }

        // A. Insert Campaign Metadata
        const { data: camp, error } = await db.from('campaigns').insert([{
            name: name,
            message: message,
            total_count: contactList.length,
            status: 'ready',
            media_data: mediaData,
            media_mime: mediaMime
        }]).select().single();
        
        if(error) { console.error(error); return null; }

        // B. Bulk Insert Queue (1000 at a time to prevent timeouts)
        // We only store Name/Number. Media is referenced in Parent Campaign.
        const queueItems = contactList.map(c => ({
            campaign_id: camp.id,
            number: c.number,
            name: c.name,
            status: 'pending'
        }));

        const chunkSize = 1000;
        for (let i = 0; i < queueItems.length; i += chunkSize) {
            await db.from('queue').insert(queueItems.slice(i, i + chunkSize));
        }

        return camp.id;
    },

    async getCampaigns() {
        const { data } = await db.from('campaigns').select('id, name, status, sent_count, total_count, failed_count, created_at').order('created_at', { ascending: false }).limit(20);
        return data || [];
    },

    // 2. Fetch Single Campaign Details (For Resume)
    async getCampaignDetails(id) {
        const { data } = await db.from('campaigns').select('*').eq('id', id).single();
        return data;
    },

    // 3. ATOMIC PROCESSOR: Fetch 1 Pending Item
    async fetchNextJob(campaignId) {
        const { data } = await db.from('queue')
            .select('*')
            .eq('campaign_id', campaignId)
            .eq('status', 'pending')
            .limit(1) // Low RAM: One at a time
            .maybeSingle();
        return data;
    },

    // 4. Update Job Status
    async completeJob(id, status) {
        await db.from('queue').update({ status: status, updated_at: new Date() }).eq('id', id);
    },

    // 5. Update Stats
    async updateStats(campId, isSuccess) {
        // In production, use RPC. Here, simple increment.
        const { data } = await db.from('campaigns').select('sent_count, failed_count').eq('id', campId).single();
        const update = isSuccess ? { sent_count: data.sent_count + 1 } : { failed_count: data.failed_count + 1 };
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
            try { file = await heic2any({ blob: file, toType: "image/jpeg" }); } catch(e){}
        }
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => resolve({ mimetype: file.type, data: reader.result.split(',')[1], filename: file.name });
        });
    }
};
