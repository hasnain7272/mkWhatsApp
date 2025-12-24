/**
 * NEXUS CORE v3.0 | Reusable Campaigns & Smart Queue
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
    // --- LISTS (Unchanged) ---
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
        return true;
    },
    async deleteList(id) { await db.from('lists').delete().eq('id', id); },

    // --- CAMPAIGNS (Upgraded) ---
    
    // 1. Create New
    async createCampaign(name, message, contactList, mediaFile) {
        let mediaData = null, mediaMime = null;
        if(mediaFile) { mediaData = mediaFile.data; mediaMime = mediaFile.mimetype; }

        const { data: camp, error } = await db.from('campaigns').insert([{
            name: name, message: message, total_count: contactList.length, status: 'ready',
            media_data: mediaData, media_mime: mediaMime
        }]).select().single();
        
        if(error) return null;
        await this._fillQueue(camp.id, contactList);
        return camp.id;
    },

    // 2. REUSE / CLONE CAMPAIGN (New Feature)
    async duplicateCampaign(oldCampId, newListId) {
        // Fetch old data
        const { data: old } = await db.from('campaigns').select('*').eq('id', oldCampId).single();
        if(!old) return null;

        // Fetch new list (or use old queue? No, lists change. Must select list.)
        // If newListId is null, we can't run. User must pick list in UI.
        const { contacts } = await this.getListContent(newListId);
        if(!contacts || !contacts.length) return null;

        // Create New Campaign Record
        const { data: newCamp } = await db.from('campaigns').insert([{
            name: `${old.name} (Copy)`,
            message: old.message,
            total_count: contacts.length,
            status: 'ready',
            media_data: old.media_data, // Copy media
            media_mime: old.media_mime
        }]).select().single();

        await this._fillQueue(newCamp.id, contacts);
        return newCamp.id;
    },

    // Helper to fill queue
    async _fillQueue(campId, contacts) {
        const queueItems = contacts.map(c => ({ campaign_id: campId, number: c.number, name: c.name, status: 'pending' }));
        const chunkSize = 1000;
        for (let i = 0; i < queueItems.length; i += chunkSize) {
            await db.from('queue').insert(queueItems.slice(i, i + chunkSize));
        }
    },

    // 3. Get Data for Dashboard
    async getCampaigns() {
        const { data } = await db.from('campaigns').select('*').order('created_at', { ascending: false }).limit(50);
        return data || [];
    },

    async getCampaignDetails(id) {
        const { data } = await db.from('campaigns').select('*').eq('id', id).single();
        return data;
    },

    // 4. Engine Fetchers
    async fetchNextJob(campaignId) {
        const { data } = await db.from('queue').select('*').eq('campaign_id', campaignId).eq('status', 'pending').limit(1).maybeSingle();
        return data;
    },
    
    // NEW: Queue Preview for UI
    async getQueuePreview(campaignId) {
        const { data } = await db.from('queue').select('name, number').eq('campaign_id', campaignId).eq('status', 'pending').limit(3);
        return data || [];
    },

    async completeJob(id, status) {
        await db.from('queue').update({ status: status, updated_at: new Date() }).eq('id', id);
    },

    async updateStats(campId, isSuccess) {
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
