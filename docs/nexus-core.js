/**
 * NEXUS CORE v4.0 | SUPABASE NATIVE SYNC
 * Key Feature: Row Locking (Pending -> Processing -> Sent) to prevent duplicates.
 */

// --- GLOBAL STATE ---
const State = { 
    user: 'client-1', 
    settings: { batch: 10, cool: 60 }, 
    activeFile: null,
    lists: [], // For Multi-Select
    isWorkerRunning: false // Local lock to prevent double-firing in same tab
};

// --- UTILS ---
const Utils = {
    toast: (msg, type='info') => { 
        const c = document.getElementById('toasts'); if(!c) return;
        const el = document.createElement('div'); 
        el.className = `${type === 'success' ? 'bg-emerald-600' : 'bg-slate-800'} text-white px-4 py-3 rounded-lg shadow-xl text-xs font-bold animate-bounce fade-in`; 
        el.innerText = msg; c.appendChild(el); setTimeout(() => el.remove(), 3000); 
    }
};

const Router = { go(p) { document.querySelectorAll('[id^="view-"]').forEach(v => v.classList.add('hidden')); document.getElementById(`view-${p}`).classList.remove('hidden'); } };

// --- DATA LAYER ---
const DataStore = {
    q(t) { return window.db.from(t); },
    
    // LISTS
    async getLists() { const { data } = await this.q('lists').select('id, name, contacts'); return data || []; },
    async getListContent(id) { const { data } = await this.q('lists').select('contacts').eq('id', id).single(); return data ? data.contacts : []; },

    // CAMPAIGN CREATION (Deduplication Logic)
    async createFullCampaign(name, msg, numbers, file) {
        // 1. Create Campaign
        const { data: camp, error } = await this.q('campaigns').insert([{ 
            name, message: msg, total_count: numbers.length, sent_count: 0, failed_count: 0, status: 'running', 
            media_data: file?.data, media_mime: file?.mimetype, media_name: file?.filename 
        }]).select().single();
        
        if(error || !camp) return null;

        // 2. Bulk Insert Queue (Set as 'pending')
        // Chunking 1000 at a time
        const chunks = [];
        for (let i = 0; i < numbers.length; i += 1000) {
            const chunk = numbers.slice(i, i + 1000).map(n => ({ campaign_id: camp.id, number: n, status: 'pending' }));
            await this.q('campaign_queue').insert(chunk);
        }
        return camp.id;
    },

    // *** THE CRITICAL FIX: FETCH & LOCK ***
    // We select 'pending' items and immediately try to process them. 
    // Note: In a pure generic browser env without RPC, we use a status 'processing' flag.
    async getPendingItems(campId, limit) {
        const { data } = await this.q('campaign_queue')
            .select('id, number')
            .eq('campaign_id', campId)
            .eq('status', 'pending')
            .limit(limit);
        return data || [];
    },

    async markProcessing(ids) {
        await this.q('campaign_queue').update({ status: 'processing', updated_at: new Date() }).in('id', ids);
    },

    async finalizeBatch(successIds, failIds) {
        if(successIds.length) await this.q('campaign_queue').update({ status: 'sent' }).in('id', successIds);
        if(failIds.length) await this.q('campaign_queue').update({ status: 'failed' }).in('id', failIds);
    },

    // SYNC
    async getActiveCampaign() { 
        const { data } = await this.q('campaigns').select('*').eq('status', 'running').order('created_at', { ascending: false }).limit(1).maybeSingle(); 
        return data; 
    },
    async getHistory() {
        const { data } = await this.q('campaigns').select('*').order('created_at', { ascending: false }).limit(20);
        return data || [];
    },
    async updateCampStats(id) {
        // Recalculate true stats from queue to be 100% accurate
        // (Optional: heavy on DB, but guarantees accuracy across devices)
        const { count: sent } = await this.q('campaign_queue').select('*', { count: 'exact', head: true }).eq('campaign_id', id).eq('status', 'sent');
        const { count: failed } = await this.q('campaign_queue').select('*', { count: 'exact', head: true }).eq('campaign_id', id).eq('status', 'failed');
        await this.q('campaigns').update({ sent_count: sent, failed_count: failed }).eq('id', id);
        return { sent, failed };
    }
};

// --- BUILDER LOGIC ---
const CampBuilder = {
    selectedLists: [],
    addList(selectEl) {
        const id = selectEl.value;
        const name = selectEl.options[selectEl.selectedIndex].text;
        if(!id) return;
        
        if(!this.selectedLists.find(l => l.id === id)) {
            this.selectedLists.push({ id, name });
            this.renderTags();
        }
        selectEl.value = "";
    },
    removeList(id) {
        this.selectedLists = this.selectedLists.filter(l => l.id !== id);
        this.renderTags();
    },
    renderTags() {
        const div = document.getElementById('camp-tags-area');
        div.innerHTML = this.selectedLists.map(l => 
            `<span class="bg-brand-50 border border-brand-200 text-brand-700 px-2 py-1 rounded-md text-[10px] font-bold flex items-center gap-1">${l.name} <button onclick="CampBuilder.removeList('${l.id}')" class="hover:text-red-500">×</button></span>`
        ).join('');
    }
};

// --- ENGINE (WORKER) ---
const Engine = {
    handleFile(i) { if(i.files[0]) { document.getElementById('file-name').innerText = i.files[0].name; const r=new FileReader(); r.readAsDataURL(i.files[0]); r.onload=()=>State.activeFile={data:r.result.split(',')[1], mimetype:i.files[0].type, filename:i.files[0].name}; } },

    async launch() {
        const name = document.getElementById('camp-name').value || "New Campaign";
        const msg = document.getElementById('camp-msg').value;
        const manual = document.getElementById('camp-manual').value;

        // 1. Deduplicate Numbers
        const finalSet = new Set();
        (manual.match(/\d{10,}/g) || []).forEach(n => finalSet.add(n));
        
        for(const l of CampBuilder.selectedLists) {
            const contacts = await DataStore.getListContent(l.id);
            contacts.forEach(c => finalSet.add(c.number));
        }

        const numbers = Array.from(finalSet);
        if(!numbers.length) return Utils.toast("No valid numbers found", "error");

        Utils.toast(`Queueing ${numbers.length} unique contacts...`);
        const id = await DataStore.createFullCampaign(name, msg, numbers, State.activeFile);
        
        if(id) {
            Utils.toast("Campaign Started!", "success");
            // Reset Form
            CampBuilder.selectedLists = []; CampBuilder.renderTags();
            document.getElementById('camp-manual').value = "";
            this.syncMonitor(); // Force UI update
        } else {
            Utils.toast("Failed to save to DB", "error");
        }
    },

    // *** UI SYNC LOOP (Reads only) ***
    async syncMonitor() {
        const active = await DataStore.getActiveCampaign();
        const panel = document.getElementById('monitor-panel');
        const sidebarStatus = document.getElementById('db-status-text');
        const sidebarBar = document.getElementById('db-progress-bar');

        if(!active) {
            panel.classList.add('hidden');
            sidebarStatus.innerText = "IDLE";
            sidebarBar.style.width = "0%";
            sidebarBar.classList.remove('bg-emerald-500'); sidebarBar.classList.add('bg-slate-400');
        } else {
            panel.classList.remove('hidden');
            document.getElementById('mon-name').innerText = active.name;
            document.getElementById('mon-total').innerText = active.total_count;
            document.getElementById('mon-sent').innerText = active.sent_count;
            document.getElementById('mon-fail').innerText = active.failed_count;
            
            // Calc Percent
            const done = active.sent_count + active.failed_count;
            const pct = active.total_count > 0 ? (done / active.total_count)*100 : 0;
            
            // Sidebar Update
            sidebarStatus.innerText = `RUNNING ${Math.round(pct)}%`;
            sidebarBar.style.width = `${pct}%`;
            sidebarBar.classList.remove('bg-slate-400'); sidebarBar.classList.add('bg-emerald-500');

            // Check if done
            if(done >= active.total_count) {
                await window.db.from('campaigns').update({ status: 'completed' }).eq('id', active.id);
                Utils.toast("Campaign Completed", "success");
            }
        }
        this.refreshHistory(); // Keep list updated
    },

    async refreshHistory() {
        const list = await DataStore.getHistory();
        const body = document.getElementById('history-body');
        body.innerHTML = list.map(c => `
            <tr class="hover:bg-slate-50 border-b border-slate-50">
                <td class="px-5 py-3"><div class="text-xs font-bold text-slate-700">${c.name}</div></td>
                <td class="px-5 py-3">
                    <div class="text-[10px] font-mono text-slate-500">${c.sent_count} / ${c.total_count}</div>
                    <div class="w-24 bg-slate-200 h-1 rounded-full"><div style="width:${(c.sent_count/c.total_count)*100}%" class="h-full bg-brand-500 rounded-full"></div></div>
                </td>
                <td class="px-5 py-3"><span class="px-2 py-1 rounded text-[10px] font-bold uppercase ${c.status==='running'?'bg-emerald-100 text-emerald-600':(c.status==='paused'?'bg-amber-100 text-amber-600':'bg-slate-100 text-slate-500')}">${c.status}</span></td>
                <td class="px-5 py-3 text-right">
                    ${c.status === 'running' ? `<button onclick="window.db.from('campaigns').update({status:'paused'}).eq('id','${c.id}')" class="text-[10px] border px-2 py-1 rounded hover:bg-slate-50">PAUSE</button>` : ''}
                    ${c.status === 'paused' ? `<button onclick="window.db.from('campaigns').update({status:'running'}).eq('id','${c.id}')" class="text-[10px] border px-2 py-1 rounded hover:bg-emerald-50 text-emerald-600">RESUME</button>` : ''}
                </td>
            </tr>
        `).join('');
    },

    // *** WORKER LOOP (Writes) ***
    async processQueue() {
        if(State.isWorkerRunning) return; // Prevent Overlap in THIS tab
        
        const active = await DataStore.getActiveCampaign();
        if(!active) {
            setTimeout(() => this.processQueue(), 2000); // Check again later
            return;
        }

        State.isWorkerRunning = true;

        // 1. FETCH & LOCK (The "Same Batch" Fix)
        // We get 'pending' items. If another tab grabbed them and marked 'processing', we won't see them.
        const batchSize = parseInt(document.querySelector('input[type="range"]')?.value || 10);
        const batch = await DataStore.getPendingItems(active.id, batchSize);

        if(batch.length === 0) {
            State.isWorkerRunning = false;
            // Maybe we are just waiting for sync update to mark completed
            setTimeout(() => this.processQueue(), 2000);
            return;
        }

        // LOCK THEM NOW
        const ids = batch.map(b => b.id);
        await DataStore.markProcessing(ids);

        // 2. PROCESS
        const success = [];
        const fail = [];

        for(const item of batch) {
            try {
                await Api.req('send', { 
                    id: State.user, 
                    number: item.number, 
                    message: active.message, 
                    file: active.media_data ? { data: active.media_data, mimetype: active.media_mime, filename: active.media_name } : null 
                });
                success.push(item.id);
            } catch(e) {
                fail.push(item.id);
            }
            // Tiny jitter
            await new Promise(r => setTimeout(r, 500));
        }

        // 3. FINALIZE STATUS
        await DataStore.finalizeBatch(success, fail);
        
        // 4. UPDATE MAIN STATS (Heavy Sync for multi-device accuracy)
        await DataStore.updateCampStats(active.id);

        // Cool Down
        State.isWorkerRunning = false;
        setTimeout(() => this.processQueue(), 1000); // Go immediately to next batch if running
    }
};

// --- SESSION & API WRAPPER ---
const Api = { async req(e,b) { try { const r=await fetch(`${window.CONFIG.API_BASE}/api/${e}`, b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{}); return r.ok?await r.json():null; } catch { return null; } } };
const Session = {
    switch(id) { State.user = id; this.renderBtn(); this.check(); },
    renderBtn() { ['client-1','client-2'].forEach(id => { const b=document.getElementById(id==='client-1'?'btn-c1':'btn-c2'); b.className=`py-2 text-[10px] font-bold rounded-lg border transition-all ${State.user===id?'border-brand-600 bg-brand-600 text-white':'bg-white text-slate-500'}`; }); },
    async check() {
        const res = await Api.req(`status/${State.user}`);
        const area = document.getElementById('action-area');
        if(res && area) {
            if(res.status==='READY') area.innerHTML = `<button onclick="Api.req('logout',{id:State.user})" class="w-full py-2 bg-red-50 text-red-600 text-xs font-bold rounded-lg">Disconnect</button>`;
            else if(res.status==='QR_READY') { 
                area.innerHTML = `<button onclick="document.getElementById('modal-qr').classList.remove('hidden')" class="w-full py-2 bg-brand-600 text-white text-xs font-bold rounded-lg">Scan QR</button>`;
                if(res.qr && window.QRious) new QRious({element:document.getElementById('qr-canvas'), value:res.qr, size:200});
            } else area.innerHTML = `<button onclick="Api.req('start',{id:State.user})" class="w-full py-2 bg-slate-800 text-white text-xs font-bold rounded-lg">Initialize</button>`;
            document.getElementById('conn-dot').className = `w-2 h-2 rounded-full ${res.status==='READY'?'bg-emerald-500':(res.status==='QR_READY'?'bg-blue-500 animate-pulse':'bg-slate-300')}`;
        }
    }
};
const Database = {
    async renderListSelector() {
        const s = document.getElementById('camp-source-selector');
        const l = await DataStore.getLists();
        s.innerHTML = '<option value="">+ Add List to Queue</option>';
        l.forEach(x => { const o = document.createElement('option'); o.value=x.id; o.innerText=`${x.name}`; s.appendChild(o); });
    }
};
