/**
 * NEXUS CORE v5.0 | FULL INTEGRATION
 * Features: Supabase Queue Locking, Multi-List Builder, Contact Manager Sync, Session Guard.
 */

// --- GLOBAL STATE ---
const State = { 
    user: 'client-1',
    status: 'OFFLINE', 
    settings: { batch: 10, cool: 60 }, 
    activeFile: null,
    
    // Contact Manager Memory
    allContacts: [], 
    selection: new Set(),
    tempMemory: new Map(), // Maps number -> name

    // Campaign Builder Memory
    builderLists: [],

    // Worker Lock
    isWorkerRunning: false 
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

const Router = { go(p) { document.querySelectorAll('[id^="view-"]').forEach(v => v.classList.add('hidden')); document.getElementById(`view-${p}`).classList.remove('hidden'); document.querySelectorAll('.nav-item').forEach(n => { n.classList.remove('bg-brand-50','text-brand-600'); n.classList.add('text-slate-500'); }); const nav = document.getElementById(`nav-${p}`); if(nav) nav.classList.add('bg-brand-50','text-brand-600'); document.getElementById('page-title').innerText = p.charAt(0).toUpperCase() + p.slice(1); document.getElementById('sidebar').classList.add('-translate-x-full'); document.getElementById('mobile-overlay').classList.add('hidden'); } };

const Settings = { save(k,v) { State.settings[k]=v; document.getElementById(`val-${k}`).innerText = v; } };

// --- DATA STORE (SUPABASE) ---
const DataStore = {
    q(t) { return window.db.from(t); },
    
    // LIST CRUD
    async getLists() { const { data } = await this.q('lists').select('id, name, contacts').order('created_at', { ascending: false }); return data || []; },
    async getListContent(id) { const { data } = await this.q('lists').select('contacts').eq('id', id).single(); return data ? data.contacts : []; },
    async saveList(name, contacts) { 
        const { data: existing } = await this.q('lists').select('id').eq('name', name).maybeSingle();
        if (existing) await this.q('lists').update({ contacts }).eq('id', existing.id);
        else await this.q('lists').insert([{ name, contacts }]);
    },
    async deleteList(id) { await this.q('lists').delete().eq('id', id); },

    // CAMPAIGN & QUEUE (The Integrity Logic)
    async createFullCampaign(name, msg, numbers, file) {
        // 1. Create Campaign Row
        const { data: camp, error } = await this.q('campaigns').insert([{ 
            name, message: msg, total_count: numbers.length, sent_count: 0, failed_count: 0, status: 'running', 
            media_data: file?.data, media_mime: file?.mimetype, media_name: file?.filename 
        }]).select().single();
        if(error || !camp) return null;

        // 2. Chunk Insert to Queue (1000 items per call)
        const chunks = [];
        for (let i = 0; i < numbers.length; i += 1000) {
            const chunk = numbers.slice(i, i + 1000).map(n => ({ campaign_id: camp.id, number: n, status: 'pending' }));
            await this.q('campaign_queue').insert(chunk);
        }
        return camp.id;
    },

    // QUEUE LOCKING SYSTEM
    async getPendingItems(campId, limit) {
        // Fetch 'pending' items
        const { data } = await this.q('campaign_queue').select('id, number').eq('campaign_id', campId).eq('status', 'pending').limit(limit);
        return data || [];
    },
    async markProcessing(ids) {
        // LOCK: Set to 'processing' so no other tab/device picks them up
        await this.q('campaign_queue').update({ status: 'processing', updated_at: new Date() }).in('id', ids);
    },
    async finalizeBatch(successIds, failIds) {
        // Finalize status
        if(successIds.length) await this.q('campaign_queue').update({ status: 'sent' }).in('id', successIds);
        if(failIds.length) await this.q('campaign_queue').update({ status: 'failed' }).in('id', failIds);
    },

    // SYNC HELPERS
    async getActiveCampaign() { return (await this.q('campaigns').select('*').eq('status', 'running').order('created_at', { ascending: false }).limit(1).maybeSingle()).data; },
    async getHistory() { return (await this.q('campaigns').select('*').order('created_at', { ascending: false }).limit(20)).data || []; },
    async updateCampStats(id) {
        // Recalculate stats from queue for absolute truth
        const { count: sent } = await this.q('campaign_queue').select('*', { count: 'exact', head: true }).eq('campaign_id', id).eq('status', 'sent');
        const { count: failed } = await this.q('campaign_queue').select('*', { count: 'exact', head: true }).eq('campaign_id', id).eq('status', 'failed');
        await this.q('campaigns').update({ sent_count: sent, failed_count: failed }).eq('id', id);
    }
};

// --- CONTACT MANAGER LOGIC ---
const ContactManager = {
    async sync() {
        const btn = document.getElementById('btn-sync'); btn.innerHTML = "...";
        const res = await Api.req(`contacts/${State.user}`);
        if(res && res.contacts) {
            // Merge into memory
            const existing = new Set(State.allContacts.map(c => c.number));
            res.contacts.forEach(c => { 
                if(!existing.has(c.number)) State.allContacts.push(c); 
                State.tempMemory.set(c.number, c.name); 
            });
            State.allContacts.sort((a,b) => (a.name||'').localeCompare(b.name||''));
            this.renderList(State.allContacts.slice(0, 100)); // Render top 100
            Utils.toast(`Synced ${res.contacts.length} contacts`, "success");
        }
        btn.innerHTML = `<i data-lucide="refresh-cw" class="w-4 h-4"></i>`; lucide.createIcons();
    },
    renderList(list) {
        const container = document.getElementById('contact-list-container'); container.innerHTML = '';
        document.getElementById('count-all').innerText = State.allContacts.length;
        list.forEach(c => {
            const isSel = State.selection.has(c.number);
            const el = document.createElement('div');
            el.className = `flex items-center justify-between p-2.5 rounded-lg cursor-pointer transition-all border mb-1 ${isSel ? 'bg-brand-50 border-brand-500' : 'bg-white border-transparent hover:bg-slate-50'}`;
            el.onclick = () => { 
                if(State.selection.has(c.number)) State.selection.delete(c.number); else State.selection.add(c.number); 
                this.renderList(list); // Re-render to update checkmark
                document.getElementById('sel-count').innerText = State.selection.size; 
            };
            el.innerHTML = `<div class="flex items-center gap-3 pointer-events-none"><div class="w-8 h-8 rounded-full ${isSel ? 'bg-brand-200 text-brand-700' : 'bg-slate-100 text-slate-500'} flex items-center justify-center text-xs font-bold shrink-0">${(c.name||'#').charAt(0).toUpperCase()}</div><div><h4 class="text-xs font-bold text-slate-700 truncate w-32 md:w-40">${c.name||'Unknown'}</h4><p class="text-[10px] text-slate-400 font-mono">${c.number}</p></div></div><div class="pointer-events-none w-4 h-4 rounded-full border ${isSel ? 'bg-brand-600 border-brand-600 text-white' : 'border-slate-300'} flex items-center justify-center text-[10px]">${isSel ? '✓' : ''}</div>`;
            container.appendChild(el);
        });
    },
    filter() { 
        const q = document.getElementById('contact-search').value.toLowerCase(); 
        this.renderList(State.allContacts.filter(c => (c.name||'').toLowerCase().includes(q) || c.number.includes(q)).slice(0, 100)); 
    },
    async saveSelection() {
        const name = document.getElementById('new-list-name').value;
        if(!name || !State.selection.size) return Utils.toast("Name or selection missing", "error");
        const listData = [];
        State.selection.forEach(num => { 
            let c = State.allContacts.find(x => x.number === num); 
            let savedName = State.tempMemory.get(num) || "Manual"; 
            listData.push({ name: c ? c.name : savedName, number: num }); 
        });
        await DataStore.saveList(name, listData);
        Utils.toast("List Saved", "success"); 
        this.clearSelection(); 
        Database.renderSavedLists(); // Refresh sidebar lists
        Database.renderListSelector(); // Refresh campaign selector
    },
    clearSelection() { 
        State.selection.clear(); 
        document.getElementById('sel-count').innerText = 0; 
        document.getElementById('new-list-name').value = ''; 
        this.filter(); 
    }
};

// --- CAMPAIGN BUILDER ---
const CampBuilder = {
    addList(selectEl) {
        const id = selectEl.value;
        const name = selectEl.options[selectEl.selectedIndex].text;
        if(!id) return;
        if(!State.builderLists.find(l => l.id === id)) {
            State.builderLists.push({ id, name });
            this.renderTags();
        }
        selectEl.value = "";
    },
    removeList(id) {
        State.builderLists = State.builderLists.filter(l => l.id !== id);
        this.renderTags();
    },
    renderTags() {
        const div = document.getElementById('camp-tags-area');
        div.innerHTML = State.builderLists.map(l => 
            `<span class="bg-brand-50 border border-brand-200 text-brand-700 px-2 py-1 rounded-md text-[10px] font-bold flex items-center gap-1">${l.name} <button onclick="CampBuilder.removeList('${l.id}')" class="hover:text-red-500">×</button></span>`
        ).join('');
    }
};

// --- ENGINE (WORKER & MONITOR) ---
const Engine = {
    handleFile(i) { if(i.files[0]) { document.getElementById('file-name').innerText = i.files[0].name; const r=new FileReader(); r.readAsDataURL(i.files[0]); r.onload=()=>State.activeFile={data:r.result.split(',')[1], mimetype:i.files[0].type, filename:i.files[0].name}; } },

    async launch() {
        const name = document.getElementById('camp-name').value || "New Campaign";
        const msg = document.getElementById('camp-msg').value;
        const manual = document.getElementById('camp-manual').value;

        // 1. DEDUPLICATE
        const finalSet = new Set();
        (manual.match(/\d{10,}/g) || []).forEach(n => finalSet.add(n));
        
        for(const l of State.builderLists) {
            const contacts = await DataStore.getListContent(l.id);
            contacts.forEach(c => finalSet.add(c.number));
        }

        const numbers = Array.from(finalSet);
        if(!numbers.length) return Utils.toast("No valid numbers found", "error");

        Utils.toast(`Queueing ${numbers.length} contacts...`);
        const id = await DataStore.createFullCampaign(name, msg, numbers, State.activeFile);
        
        if(id) {
            Utils.toast("Campaign Started!", "success");
            State.builderLists = []; CampBuilder.renderTags(); document.getElementById('camp-manual').value = "";
            this.syncMonitor();
        } else {
            Utils.toast("Database Error", "error");
        }
    },

    // UI MONITOR (READ-ONLY)
    async syncMonitor() {
        const active = await DataStore.getActiveCampaign();
        const panel = document.getElementById('monitor-panel');
        const sidebarBar = document.getElementById('db-progress-bar');
        const sidebarStatus = document.getElementById('db-status-text');

        if(!active) {
            panel.classList.add('hidden');
            sidebarBar.style.width = "0%";
            sidebarStatus.innerText = "IDLE";
            return;
        }

        panel.classList.remove('hidden');
        document.getElementById('mon-name').innerText = active.name;
        document.getElementById('mon-total').innerText = active.total_count;
        document.getElementById('mon-sent').innerText = active.sent_count;
        document.getElementById('mon-fail').innerText = active.failed_count;
        
        const done = active.sent_count + active.failed_count;
        const pct = active.total_count > 0 ? (done / active.total_count)*100 : 0;
        
        sidebarStatus.innerText = `RUNNING ${Math.round(pct)}%`;
        sidebarBar.style.width = `${pct}%`;
        sidebarBar.classList.remove('bg-slate-400'); sidebarBar.classList.add('bg-emerald-500');

        if(done >= active.total_count) {
            await window.db.from('campaigns').update({ status: 'completed' }).eq('id', active.id);
            Utils.toast("Campaign Completed", "success");
        }
        this.refreshHistory();
    },

    async refreshHistory() {
        const list = await DataStore.getHistory();
        document.getElementById('history-body').innerHTML = list.map(c => `
            <tr class="hover:bg-slate-50 border-b border-slate-50">
                <td class="px-5 py-3"><div class="text-xs font-bold text-slate-700">${c.name}</div></td>
                <td class="px-5 py-3"><div class="w-24 bg-slate-200 h-1 rounded-full"><div style="width:${c.total_count ? (c.sent_count/c.total_count)*100 : 0}%" class="h-full bg-brand-500 rounded-full"></div></div></td>
                <td class="px-5 py-3"><span class="px-2 py-1 rounded text-[10px] font-bold uppercase ${c.status==='running'?'bg-emerald-100 text-emerald-600':'bg-slate-100 text-slate-500'}">${c.status}</span></td>
                <td class="px-5 py-3 text-right">
                    ${c.status === 'running' ? `<button onclick="window.db.from('campaigns').update({status:'paused'}).eq('id','${c.id}')" class="text-[10px] border px-2 py-1 rounded">PAUSE</button>` : ''}
                    ${c.status === 'paused' ? `<button onclick="window.db.from('campaigns').update({status:'running'}).eq('id','${c.id}')" class="text-[10px] border px-2 py-1 rounded text-emerald-600">RESUME</button>` : ''}
                </td>
            </tr>
        `).join('');
    },

    // WORKER (WRITE / SEND)
    async processQueue() {
        if(State.isWorkerRunning) return; // Local Lock
        
        // 1. Session Check
        if(State.status !== 'READY') {
            setTimeout(() => this.processQueue(), 2000); // Wait for connection
            return;
        }

        const active = await DataStore.getActiveCampaign();
        if(!active) { setTimeout(() => this.processQueue(), 2000); return; }

        State.isWorkerRunning = true;

        // 2. Fetch & Lock (Atomic-like)
        const batchSize = parseInt(State.settings.batch) || 10;
        const batch = await DataStore.getPendingItems(active.id, batchSize);

        if(!batch.length) {
            State.isWorkerRunning = false;
            setTimeout(() => this.processQueue(), 2000);
            return;
        }

        const ids = batch.map(b => b.id);
        await DataStore.markProcessing(ids); // Set to 'processing'

        // 3. Process
        const success = [], fail = [];
        for(const item of batch) {
            try {
                // Actual API Call
                await Api.req('send', { 
                    id: State.user, 
                    number: item.number, 
                    message: active.message, 
                    file: active.media_data ? { data: active.media_data, mimetype: active.media_mime, filename: active.media_name } : null 
                });
                success.push(item.id);
            } catch(e) { fail.push(item.id); }
            await new Promise(r => setTimeout(r, 500)); // Jitter
        }

        // 4. Finalize
        await DataStore.finalizeBatch(success, fail);
        await DataStore.updateCampStats(active.id);

        State.isWorkerRunning = false;
        setTimeout(() => this.processQueue(), 1000); // Next batch
    }
};

// --- DATABASE UI HELPERS ---
const Database = {
    async renderListSelector() {
        const s = document.getElementById('camp-source-selector');
        const l = await DataStore.getLists();
        s.innerHTML = '<option value="">+ Add List to Queue</option>';
        l.forEach(x => { const o = document.createElement('option'); o.value=x.id; o.innerText=`${x.name}`; s.appendChild(o); });
        document.getElementById('stat-lists').innerText = l.length;
    },
    async renderSavedLists() {
        const grid = document.getElementById('contact-grid');
        const lists = await DataStore.getLists();
        grid.innerHTML = lists.map(l => `
            <div class="flex justify-between items-center p-3 bg-slate-50 border border-slate-200 rounded-lg">
                <div><p class="text-xs font-bold text-slate-700">${l.name}</p><p class="text-[10px] text-slate-400">${l.count||0} items</p></div>
                <button onclick="DataStore.deleteList('${l.id}').then(()=>Database.renderSavedLists())" class="text-slate-400 hover:text-red-500"><i data-lucide="trash" class="w-3 h-3"></i></button>
            </div>
        `).join('');
        lucide.createIcons();
    }
};

// --- API & SESSION ---
const Api = { async req(e,b) { try { const r=await fetch(`${window.CONFIG.API_BASE}/api/${e}`, b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{}); return r.ok?await r.json():null; } catch { return null; } } };
const Session = {
    switch(id) { State.user = id; this.renderBtn(); this.check(); },
    renderBtn() { ['client-1','client-2'].forEach(id => { const b=document.getElementById(id==='client-1'?'btn-c1':'btn-c2'); b.className=`py-2 text-[10px] font-bold rounded-lg border transition-all ${State.user===id?'border-brand-600 bg-brand-600 text-white':'bg-white text-slate-500'}`; }); },
    async check() {
        const res = await Api.req(`status/${State.user}`);
        const area = document.getElementById('action-area');
        if(res && area) {
            State.status = res.status;
            if(res.status==='READY') area.innerHTML = `<button onclick="Api.req('logout',{id:State.user})" class="w-full py-2 bg-red-50 text-red-600 text-xs font-bold rounded-lg">Disconnect</button>`;
            else if(res.status==='QR_READY') { 
                area.innerHTML = `<button onclick="document.getElementById('modal-qr').classList.remove('hidden')" class="w-full py-2 bg-brand-600 text-white text-xs font-bold rounded-lg">Scan QR</button>`;
                if(res.qr && window.QRious) new QRious({element:document.getElementById('qr-canvas'), value:res.qr, size:200});
            } else area.innerHTML = `<button onclick="Api.req('start',{id:State.user})" class="w-full py-2 bg-slate-800 text-white text-xs font-bold rounded-lg">Initialize</button>`;
            document.getElementById('conn-dot').className = `w-2 h-2 rounded-full ${res.status==='READY'?'bg-emerald-500':(res.status==='QR_READY'?'bg-blue-500 animate-pulse':'bg-slate-300')}`;
        }
    }
};
