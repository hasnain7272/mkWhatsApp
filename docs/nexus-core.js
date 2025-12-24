/**
 * NEXUS CORE v3.0 | Database-Driven Engine
 * Persists state to Supabase for crash recovery.
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
    // --- LIST MANAGEMENT (Keep existing) ---
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

    // --- NEW: CAMPAIGN MANAGEMENT ---
    
    // 1. Create New Campaign (Offload RAM to DB)
    async createCampaign(name, message, contactList) {
        // A. Create Campaign Record
        const { data: camp, error } = await db.from('campaigns').insert([{
            name: name,
            message: message,
            total_count: contactList.length,
            status: 'ready'
        }]).select().single();
        
        if(error) return null;

        // B. Bulk Insert Queue Items (Efficiently)
        const queueItems = contactList.map(c => ({
            campaign_id: camp.id,
            number: c.number,
            name: c.name,
            status: 'pending'
        }));

        // Insert in chunks of 1000 to prevent timeouts
        const chunkSize = 1000;
        for (let i = 0; i < queueItems.length; i += chunkSize) {
            await db.from('queue').insert(queueItems.slice(i, i + chunkSize));
        }

        return camp.id;
    },

    // 2. Fetch Recent Campaigns
    async getCampaigns() {
        const { data } = await db.from('campaigns').select('*').order('created_at', { ascending: false }).limit(20);
        return data || [];
    },

    // 3. Get Next Batch (The "Fetcher")
    async getPendingBatch(campaignId, size) {
        const { data } = await db.from('queue')
            .select('*')
            .eq('campaign_id', campaignId)
            .eq('status', 'pending')
            .limit(size);
        return data || [];
    },

    // 4. Update Status (The "Marker")
    async markSent(ids, status = 'sent') {
        if(ids.length === 0) return;
        await db.from('queue').update({ status: status, updated_at: new Date() }).in('id', ids);
    },

    // 5. Update Campaign Stats
    async updateCampaignStats(id, sent, failed) {
        // Increment atomic counters (simplified for client-side)
        // Note: For perfect accuracy we would use an RPC function, but this works for MVP
        const { data } = await db.from('campaigns').select('sent_count, failed_count').eq('id', id).single();
        await db.from('campaigns').update({ 
            sent_count: data.sent_count + sent, 
            failed_count: data.failed_count + failed 
        }).eq('id', id);
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
