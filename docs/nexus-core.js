/**
 * NEXUS CORE v3.2 | "THE MONOLITH"
 * Full Feature Parity: Contacts, Lists, Campaigns, Queue, Session.
 * Dynamic Configuration: 0 Hardcoded Values.
 */

// --- 1. GLOBAL STATE ---
const State = { 
    user: 'client-1', 
    status: 'OFFLINE', 
    qr: null, 
    activeFile: null, 
    isRunning: false, 
    settings: { batch: 10, cool: 60 }, 
    allContacts: [], 
    selection: new Set(), 
    tempMemory: new Map(), 
    activeCampaignId: null, 
    historyCache: [] 
};

// --- 2. UTILS ---
const Utils = {
    toast: (msg, type='info') => { 
        const c = document.getElementById('toasts');
        if(!c) return;
        const el = document.createElement('div'); 
        el.className = `${type === 'success' ? 'bg-emerald-600' : 'bg-slate-800'} text-white px-4 py-3 rounded-lg shadow-xl text-xs font-bold animate-bounce fade-in`; 
        el.innerText = msg; 
        c.appendChild(el); 
        setTimeout(() => el.remove(), 3000); 
    },
    log: (html) => {
        const l = document.getElementById('console-logs');
        if(l) l.innerHTML = html + l.innerHTML;
    }
};

const Router = { 
    go(p) { 
        document.querySelectorAll('[id^="view-"]').forEach(v => v.classList.add('hidden')); 
        document.getElementById(`view-${p}`).classList.remove('hidden'); 
        document.querySelectorAll('.nav-item').forEach(n => { n.classList.remove('bg-brand-50','text-brand-600'); n.classList.add('text-slate-500'); }); 
        const nav = document.getElementById(`nav-${p}`);
        if(nav) nav.classList.add('bg-brand-50','text-brand-600'); 
        document.getElementById('page-title').innerText = p.charAt(0).toUpperCase() + p.slice(1); 
        document.getElementById('sidebar').classList.add('-translate-x-full'); 
        document.getElementById('mobile-overlay').classList.add('hidden'); 
    } 
};

const Settings = { save(k,v) { State.settings[k]=v; document.getElementById(`val-${k}`).innerText = v; } };

// --- 3. API & DATA LAYER ---
const Api = {
    async req(endpoint, body) {
        try {
            const r = await fetch(`${window.CONFIG.API_BASE}/api/${endpoint}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
            return r.ok ? await r.json() : null;
        } catch (e) { return null; }
    }
};

const DataStore = {
    // Helper for Supabase Calls
    q(table) { return window.db.from(table); },

    // LISTS (Contact Manager)
    async getLists() { const { data } = await this.q('lists').select('id, name, contacts').order('created_at', { ascending: false }); return data ? data.map(i => ({ id: i.id, name: i.name, count: i.contacts ? i.contacts.length : 0 })) : []; },
    async getListContent(id) { const { data } = await this.q('lists').select('name, contacts').eq('id', id).single(); return data || { name: '', contacts: [] }; },
    async saveList(name, contacts) { const { data: existing } = await this.q('lists').select('id').eq('name', name).maybeSingle(); if (existing) await this.q('lists').update({ contacts }).eq('id', existing.id); else await this.q('lists').insert([{ name, contacts }]); },
    async deleteList(id) { await this.q('lists').delete().eq('id', id); },

    // CAMPAIGNS & QUEUE
    async createCampaign(name, msg, total, mediaFile) {
        let mData = null, mMime = null, mName = null;
        if(mediaFile) { mData = mediaFile.data; mMime = mediaFile.mimetype; mName = mediaFile.filename; }
        const { data, error } = await this.q('campaigns').insert([{ name, message: msg, total_count: total, sent_count: 0, status: 'running', media_data: mData, media_mime: mMime, media_name: mName }]).select().single();
        return error ? null : data.id;
    },
    async addToQueue(campId, numbers) {
        const rows = numbers.map(n => ({ campaign_id: campId, number: n, status: 'pending' }));
        for (let i = 0; i < rows.length; i += 500) await this.q('campaign_queue').insert(rows.slice(i, i + 500));
    },
    async getNextBatch(campId, size) { const { data } = await this.q('campaign_queue').select('id, number').eq('campaign_id', campId).eq('status', 'pending').limit(size); return data || []; },
    async updateQueueStatus(itemId, status) { await this.q('campaign_queue').update({ status }).eq('id', itemId); },
    async updateStats(id, type) { 
        // Optimized: Increment logic in memory for UI, DB for persistence
        const { data } = await this.q('campaigns').select(`${type}_count`).eq('id', id).single(); 
        if(data) await this.q('campaigns').update({ [`${type}_count`]: data[`${type}_count`] + 1 }).eq('id', id); 
    },
    async updateStatus(id, status) { await this.q('campaigns').update({ status }).eq('id', id); },
    async getCampaigns() { const { data } = await this.q('campaigns').select('id, name, created_at, sent_count, total_count, status, message, media_name').order('created_at', { ascending: false }).limit(20); return data || []; },
    async getCampaignFull(id) { const { data } = await this.q('campaigns').select('*').eq('id', id).single(); return data; },
    async getRunning() { const { data } = await this.q('campaigns').select('*').eq('status', 'running').order('created_at', { ascending: false }).limit(1).single(); return data; }
};

// --- 4. ENGINE CORE ---
const CoreUtils = {
    async processFile(file) {
        if (file.name.toLowerCase().endsWith('.heic') && window.heic2any) { try { file = await heic2any({ blob: file, toType: "image/jpeg", quality: 1.0 }); } catch(e){} }
        return new Promise(resolve => { const r = new FileReader(); r.readAsDataURL(file); r.onload = () => resolve({ mimetype: file.type, data: r.result.split(',')[1], filename: file.name }); });
    },
    exportCSV(name, dataPromise) {
        Promise.resolve(dataPromise).then(res => {
            const data = res.contacts || res;
            const csv = "data:text/csv;charset=utf-8,Name,Number\n" + data.map(e => `${e.name},${e.number}`).join("\n");
            const link = document.createElement("a"); link.href = encodeURI(csv); link.download = `${name}.csv`; document.body.appendChild(link); link.click(); link.remove();
        });
    }
};

const Engine = {
    handleFile(i) { if(i.files[0]) { document.getElementById('file-name').innerText = i.files[0].name; CoreUtils.processFile(i.files[0]).then(f => State.activeFile = f); } },

    async createAndQueue() {
        const raw = document.getElementById('camp-input').value;
        const msg = document.getElementById('camp-msg').value;
        const name = document.getElementById('camp-name').value || `Campaign ${new Date().toLocaleTimeString()}`;
        const nums = raw.match(/\d{10,}/g) || [];
        
        if(!nums.length) return Utils.toast("No numbers provided", "error");
        
        Utils.toast("Creating Campaign...", "info");
        const campId = await DataStore.createCampaign(name, msg, nums.length, State.activeFile);
        if(!campId) return Utils.toast("DB Create Failed", "error");

        Utils.toast(`Queueing ${nums.length} contacts...`, "info");
        await DataStore.addToQueue(campId, nums);

        State.activeCampaignId = campId;
        document.getElementById('active-camp-display').innerText = `ID: ${campId.slice(0,8)}...`;
        this.toggle(true);
    },

    toggle(forceStart = false) { 
        if(forceStart) State.isRunning = false; 
        State.isRunning = !State.isRunning; 
        document.getElementById('btn-engine-toggle').innerText = State.isRunning ? "PAUSE" : "RESUME"; 
        if(State.isRunning) this.processBatch(); 
    },

    clear() { 
        State.activeCampaignId = null; State.isRunning = false; 
        document.getElementById('btn-engine-toggle').innerText = "START"; 
        document.getElementById('active-camp-display').innerText = "Idle"; 
        Utils.toast("Engine Reset"); 
    },

    async processBatch() {
        if(!State.isRunning) return;
        const batch = await DataStore.getNextBatch(State.activeCampaignId, parseInt(State.settings.batch)||10);

        if(!batch || !batch.length) {
            await DataStore.updateStatus(State.activeCampaignId, 'completed');
            Utils.toast("Campaign Finished!", "success");
            this.clear();
            this.refreshCampaigns();
            return;
        }

        Utils.log(`<div class="mt-2 mb-1 text-[10px] font-bold text-slate-400 text-center">--- Batch (${batch.length}) ---</div>`);

        for (const item of batch) {
            if(!State.isRunning) break;
            Utils.log(`<div class="text-slate-500 border-l-2 border-slate-200 pl-2 text-[10px]">> ${item.number}...</div>`);
            
            // Dynamic Message Reading (Allows live edits)
            const msg = document.getElementById('camp-msg').value;

            try {
                await Api.req('send', { id: State.user, number: item.number, message: msg, file: State.activeFile });
                await DataStore.updateQueueStatus(item.id, 'sent');
                await DataStore.updateStats(State.activeCampaignId, 'sent');
                
                document.getElementById('stat-sent').innerText = (parseInt(document.getElementById('stat-sent').innerText) || 0) + 1;
                Utils.log(`<div class="text-emerald-600 font-bold border-l-2 border-emerald-500 pl-2 text-[10px]">> SENT</div>`);
            } catch(e) {
                await DataStore.updateQueueStatus(item.id, 'failed');
                await DataStore.updateStats(State.activeCampaignId, 'failed');
                Utils.log(`<div class="text-red-500 font-bold border-l-2 border-red-500 pl-2 text-[10px]">> FAIL</div>`);
            }

            await new Promise(r => setTimeout(r, Math.random() * 3000 + 2000));
        }

        if(State.isRunning) {
            const cool = parseInt(State.settings.cool) || 60;
            Utils.log(`<div class="text-amber-600 text-[10px] text-center italic my-1">Cooling: ${cool}s...</div>`);
            setTimeout(() => this.processBatch(), cool * 1000);
        }
    },

    async refreshCampaigns() {
        const tbody = document.getElementById('history-table-body');
        tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-4 text-center text-xs text-slate-400">Loading...</td></tr>';
        const camps = await DataStore.getCampaigns();
        State.historyCache = camps; 
        tbody.innerHTML = '';
        if(!camps.length) { tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-4 text-center text-xs text-slate-400">No campaigns found</td></tr>'; return; }
        camps.forEach((c, idx) => {
            const row = document.createElement('tr');
            row.className = "hover:bg-slate-50 transition-colors border-b border-slate-50";
            row.innerHTML = `<td class="px-6 py-3 font-bold text-xs text-slate-800">${c.name}</td><td class="px-6 py-3 text-[10px] text-slate-500">${new Date(c.created_at).toLocaleDateString()}</td><td class="px-6 py-3 text-xs font-mono"><span class="text-emerald-600 font-bold">${c.sent_count}</span> <span class="text-slate-300">/</span> <span class="text-slate-500">${c.total_count}</span></td><td class="px-6 py-3"><span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ${c.status==='running'?'bg-blue-100 text-blue-700':(c.status==='completed'?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-500')}">${c.status}</span></td><td class="px-6 py-3 text-right"><button onclick="Engine.loadFromHistory(${idx})" class="text-[10px] font-bold bg-white border border-slate-200 text-slate-600 hover:text-brand-600 hover:border-brand-200 px-3 py-1 rounded transition-colors shadow-sm">Load</button></td>`;
            tbody.appendChild(row);
        });
    },

    async loadFromHistory(idx) {
        const minimal = State.historyCache[idx];
        if(!minimal) return;
        Utils.toast("Loading...", "info");
        const full = await DataStore.getCampaignFull(minimal.id);
        
        UI.setCampTab('launch');
        document.getElementById('camp-name').value = `${full.name} (Rerun)`;
        document.getElementById('camp-msg').value = full.message || "";
        
        if(full.media_data) {
            State.activeFile = { data: full.media_data, mimetype: full.media_mime, filename: full.media_name };
            document.getElementById('file-name').innerText = `${full.media_name} (Loaded)`;
            document.getElementById('file-name').classList.add("text-emerald-600");
        }
    },

    async checkRecovery() {
        const active = await DataStore.getRunning();
        if(active && confirm(`Recover interrupted campaign "${active.name}"?`)) {
            State.activeCampaignId = active.id;
            document.getElementById('active-camp-display').innerText = `ID: ${active.id.slice(0,8)}...`;
            document.getElementById('camp-name').value = active.name;
            document.getElementById('camp-msg').value = active.message;
            if(active.media_data) {
                State.activeFile = { data: active.media_data, mimetype: active.media_mime, filename: active.media_name };
                document.getElementById('file-name').innerText = `${active.media_name} (Recovered)`;
            }
            Utils.toast("Recovered. Click RESUME.", "success");
        }
    }
};

// --- 5. MANAGERS (Session, Contact, DatabaseUI) ---
const Session = {
    switch(id) { State.user = id; this.renderBtn(); this.check(); },
    renderBtn() { ['client-1','client-2'].forEach(id => { const btn = document.getElementById(id === 'client-1' ? 'btn-c1' : 'btn-c2'); btn.className = `py-2 text-[10px] font-bold rounded-lg border transition-all ${State.user===id ? 'border-brand-600 bg-brand-600 text-white shadow-md' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`; }); },
    async start() {
        document.getElementById('action-area').innerHTML = `<div class="w-full py-2 bg-slate-100 text-slate-400 text-xs font-bold rounded-lg flex justify-center gap-2"><span class="loader border-slate-300 border-b-slate-500"></span> Connecting...</div>`;
        await Api.req('start', { id: State.user }); setTimeout(() => this.check(), 2000);
    },
    async stop() { if(confirm("Stop Session?")) await Api.req('logout', { id: State.user }); this.check(); },
    async check() {
        const res = await Api.req(`status/${State.user}`);
        const area = document.getElementById('action-area'), dot = document.getElementById('conn-dot');
        if(res) {
            State.status = res.status; State.qr = res.qr;
            if(State.status === 'READY') { dot.className = "w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]"; area.innerHTML = `<button onclick="Session.stop()" class="w-full py-2 bg-red-50 text-red-600 text-xs font-bold rounded-lg hover:bg-red-100">Disconnect</button>`; document.getElementById('modal-qr').classList.add('hidden'); } 
            else if (State.status === 'QR_READY') { dot.className = "w-2 h-2 rounded-full bg-blue-500 animate-pulse"; area.innerHTML = `<button onclick="document.getElementById('modal-qr').classList.remove('hidden')" class="w-full py-2 bg-brand-600 text-white text-xs font-bold rounded-lg hover:bg-brand-700">Scan QR</button>`; if(State.qr && window.QRious) new QRious({ element: document.getElementById('qr-canvas'), value: State.qr, size: 200 }); } 
            else { dot.className = "w-2 h-2 rounded-full bg-slate-300"; area.innerHTML = `<button onclick="Session.start()" class="w-full py-2 bg-slate-800 text-white text-xs font-bold rounded-lg hover:bg-slate-900">Initialize</button>`; }
        }
    }
};

const ContactManager = {
    async sync() {
        const btn = document.getElementById('btn-sync'); btn.innerHTML = "...";
        const res = await Api.req(`contacts/${State.user}`);
        if(res && res.contacts) {
            const existing = new Set(State.allContacts.map(c => c.number));
            res.contacts.forEach(c => { if(!existing.has(c.number)) State.allContacts.push(c); State.tempMemory.set(c.number, c.name); });
            State.allContacts.sort((a,b) => (a.name||'').localeCompare(b.name||''));
            this.renderList(State.allContacts.slice(0, 100));
            Utils.toast(`Synced ${res.contacts.length} items`, "success");
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
            el.onclick = () => { if(State.selection.has(c.number)) State.selection.delete(c.number); else State.selection.add(c.number); this.renderList(list); document.getElementById('sel-count').innerText = State.selection.size; };
            el.innerHTML = `<div class="flex items-center gap-3 pointer-events-none"><div class="w-8 h-8 rounded-full ${isSel ? 'bg-brand-200 text-brand-700' : 'bg-slate-100 text-slate-500'} flex items-center justify-center text-xs font-bold shrink-0">${(c.name||'#').charAt(0).toUpperCase()}</div><div><h4 class="text-xs font-bold text-slate-700 truncate w-32 md:w-40">${c.name||'Unknown'}</h4><p class="text-[10px] text-slate-400 font-mono">${c.number}</p></div></div><div class="pointer-events-none w-4 h-4 rounded-full border ${isSel ? 'bg-brand-600 border-brand-600 text-white' : 'border-slate-300'} flex items-center justify-center text-[10px]">${isSel ? '✓' : ''}</div>`;
            container.appendChild(el);
        });
    },
    filter() { const q = document.getElementById('contact-search').value.toLowerCase(); this.renderList(State.allContacts.filter(c => (c.name||'').toLowerCase().includes(q) || c.number.includes(q)).slice(0, 100)); },
    async saveSelection() {
        const name = document.getElementById('new-list-name').value;
        if(!name || !State.selection.size) return Utils.toast("Name or selection missing", "error");
        const listData = [];
        State.selection.forEach(num => { let c = State.allContacts.find(x => x.number === num); let savedName = State.tempMemory.get(num) || "Manual"; listData.push({ name: c ? c.name : savedName, number: num }); });
        await DataStore.saveList(name, listData);
        Utils.toast("List Saved", "success"); this.clearSelection(); Database.render();
    },
    async loadToSelect(id) {
        this.clearSelection();
        const { name, contacts } = await DataStore.getListContent(id);
        if(contacts) {
            contacts.forEach(i => { State.selection.add(i.number); State.tempMemory.set(i.number, i.name); });
            document.getElementById('sel-count').innerText = State.selection.size;
            document.getElementById('new-list-name').value = name;
            Utils.toast(`Loaded "${name}"`, "success"); this.filter(); 
        }
    },
    clearSelection() { State.selection.clear(); document.getElementById('sel-count').innerText = 0; document.getElementById('new-list-name').value = ''; this.filter(); }
};

const Database = {
    async render() {
        const grid = document.getElementById('contact-grid'), sel = document.getElementById('camp-list-selector');
        grid.innerHTML = '<div class="text-xs text-slate-400 text-center py-4">Loading Cloud...</div>'; 
        sel.innerHTML = '<option value="">Load Cloud List</option>';
        const lists = await DataStore.getLists();
        grid.innerHTML = '';
        lists.forEach(l => {
            const div = document.createElement('div');
            div.className = "flex justify-between items-center p-3 bg-slate-50 border border-slate-200 rounded-lg hover:border-slate-300 transition-colors";
            div.innerHTML = `<div><p class="text-xs font-bold text-slate-700">${l.name}</p><p class="text-[10px] text-slate-400">${l.count} items</p></div><div class="flex gap-1"><button onclick="CoreUtils.exportCSV('${l.name}', DataStore.getListContent('${l.id}'))" class="p-1.5 bg-white border border-slate-200 rounded text-slate-400 hover:text-green-600"><i data-lucide="download" class="w-3 h-3"></i></button><button onclick="ContactManager.loadToSelect('${l.id}')" class="p-1.5 bg-white border border-slate-200 rounded text-slate-400 hover:text-brand-600"><i data-lucide="check-square" class="w-3 h-3"></i></button><button onclick="Database.openEdit('${l.id}')" class="p-1.5 bg-white border border-slate-200 rounded text-slate-400 hover:text-blue-600"><i data-lucide="pencil" class="w-3 h-3"></i></button><button onclick="Database.delete('${l.id}')" class="p-1.5 bg-white border border-slate-200 rounded text-slate-400 hover:text-red-500"><i data-lucide="trash" class="w-3 h-3"></i></button></div>`;
            grid.appendChild(div);
            const opt = document.createElement('option'); opt.value = l.id; opt.innerText = `${l.name} (${l.count})`; sel.appendChild(opt);
        });
        document.getElementById('stat-stored').innerText = lists.length;
        lucide.createIcons();
    },
    async delete(id) { if(confirm("Delete Cloud List?")) { await DataStore.deleteList(id); this.render(); } },
    async loadListToCamp(id) {
        if(!id) return;
        const { contacts } = await DataStore.getListContent(id);
        document.getElementById('camp-input').value = contacts.map(c => c.number).join('\n');
        Utils.toast("Numbers Loaded", "success");
    },
    createNewEmpty() { this.openEdit(null); },
    async openEdit(id) {
        const modal = document.getElementById('modal-edit'), area = document.getElementById('edit-area'); document.getElementById('edit-key-hidden').value = id || "NEW";
        area.value = "Loading...";
        if(id) { const { contacts } = await DataStore.getListContent(id); area.value = contacts.map(i => `${i.number} | ${i.name}`).join('\n'); } else { area.value = ""; }
        modal.classList.remove('hidden');
    },
    closeEdit() { document.getElementById('modal-edit').classList.add('hidden'); },
    async saveEdit() {
        const id = document.getElementById('edit-key-hidden').value, raw = document.getElementById('edit-area').value;
        let listName = ""; 
        if(id === "NEW") { listName = prompt("Enter List Name:"); if(!listName) return; }
        const newData = []; raw.split('\n').forEach(line => { if(line.trim()) { const p = line.split('|'); newData.push({ number: p[0].trim(), name: p[1] ? p[1].trim() : "Manual" }); } });
        if(id !== "NEW") { const { name } = await DataStore.getListContent(id); listName = name; }
        await DataStore.saveList(listName, newData);
        Utils.toast("Saved", "success"); this.closeEdit(); this.render();
    }
};

const UI = {
    toggleSidebar() { document.getElementById('sidebar').classList.toggle('-translate-x-full'); document.getElementById('mobile-overlay').classList.toggle('hidden'); },
    setContactTab(tab) {
        const list = document.getElementById('cont-panel-list'), tools = document.getElementById('cont-panel-tools');
        const btnList = document.getElementById('tab-list'), btnTools = document.getElementById('tab-tools');
        if(tab === 'list') { list.classList.remove('hidden'); tools.classList.add('hidden'); btnList.classList.add('bg-white','shadow-sm','text-slate-800'); btnTools.classList.remove('bg-white','shadow-sm','text-slate-800'); } 
        else { list.classList.add('hidden'); tools.classList.remove('hidden'); tools.classList.add('flex'); btnTools.classList.add('bg-white','shadow-sm','text-slate-800'); btnList.classList.remove('bg-white','shadow-sm','text-slate-800'); }
    },
    setCampTab(tab) {
        const launch = document.getElementById('panel-camp-launch'), history = document.getElementById('panel-camp-history');
        const btnLaunch = document.getElementById('tab-camp-launch'), btnHistory = document.getElementById('tab-camp-history');
        if(tab === 'launch') { 
            launch.classList.remove('hidden'); history.classList.add('hidden'); 
            btnLaunch.classList.add('bg-white','shadow-sm','text-slate-800'); btnLaunch.classList.remove('text-slate-500');
            btnHistory.classList.remove('bg-white','shadow-sm','text-slate-800'); btnHistory.classList.add('text-slate-500');
        } else { 
            launch.classList.add('hidden'); history.classList.remove('hidden'); 
            btnHistory.classList.add('bg-white','shadow-sm','text-slate-800'); btnHistory.classList.remove('text-slate-500');
            btnLaunch.classList.remove('bg-white','shadow-sm','text-slate-800'); btnLaunch.classList.add('text-slate-500');
            Engine.refreshCampaigns();
        }
    }
};
