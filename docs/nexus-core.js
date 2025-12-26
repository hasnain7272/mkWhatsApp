/**
 * NEXUS CORE v3.3 | "THE HIVE" 
 * Architecture: Multi-List Deduplication, Individual Campaign Control, Optimistic Queueing.
 */

// --- 1. GLOBAL STATE ---
const State = { 
    user: 'client-1', 
    status: 'OFFLINE', 
    qr: null, 
    activeFile: null,
    settings: { batch: 10, cool: 60 }, 
    allContacts: [], 
    selection: new Set(), 
    tempMemory: new Map(),
    
    // Campaign Builder Context
    campBuilder: { lists: [], manual: "" },
    
    // Engine Context
    engine: { running: false }
};

// --- 2. UTILS ---
const Utils = {
    toast: (msg, type='info') => { 
        const c = document.getElementById('toasts');
        if(!c) return;
        const el = document.createElement('div'); 
        el.className = `${type === 'success' ? 'bg-emerald-600' : (type==='error'?'bg-red-600':'bg-slate-800')} text-white px-4 py-3 rounded-lg shadow-xl text-xs font-bold animate-bounce fade-in`; 
        el.innerText = msg; 
        c.appendChild(el); 
        setTimeout(() => el.remove(), 3000); 
    },
    log: (html) => {
        const l = document.getElementById('console-logs');
        if(l) {
            l.innerHTML += html;
            l.scrollTop = l.scrollHeight; 
        }
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
    q(table) { return window.db.from(table); },

    // LISTS
    async getLists() { const { data } = await this.q('lists').select('id, name, contacts').order('created_at', { ascending: false }); return data ? data.map(i => ({ id: i.id, name: i.name, count: i.contacts ? i.contacts.length : 0 })) : []; },
    async getListContent(id) { const { data } = await this.q('lists').select('name, contacts').eq('id', id).single(); return data || { name: '', contacts: [] }; },
    async saveList(name, contacts) { const { data: existing } = await this.q('lists').select('id').eq('name', name).maybeSingle(); if (existing) await this.q('lists').update({ contacts }).eq('id', existing.id); else await this.q('lists').insert([{ name, contacts }]); },
    async deleteList(id) { await this.q('lists').delete().eq('id', id); },

    // CAMPAIGNS
    async createCampaign(name, msg, total, mediaFile) {
        let mData = null, mMime = null, mName = null;
        if(mediaFile) { mData = mediaFile.data; mMime = mediaFile.mimetype; mName = mediaFile.filename; }
        const { data, error } = await this.q('campaigns').insert([{ name, message: msg, total_count: total, sent_count: 0, failed_count: 0, status: 'paused', media_data: mData, media_mime: mMime, media_name: mName }]).select().single();
        return error ? null : data.id;
    },
    async addToQueue(campId, numbers) {
        // Optimized Chunking (1000 limit)
        const rows = numbers.map(n => ({ campaign_id: campId, number: n, status: 'pending' }));
        for (let i = 0; i < rows.length; i += 1000) await this.q('campaign_queue').insert(rows.slice(i, i + 1000));
    },
    async getNextBatch(campId, size) { 
        const { data } = await this.q('campaign_queue').select('id, number').eq('campaign_id', campId).eq('status', 'pending').limit(size); 
        return data || []; 
    },
    
    // BULK UPDATES
    async batchUpdateStatus(successIds, failIds) {
        if(successIds.length) await this.q('campaign_queue').update({ status: 'sent', updated_at: new Date() }).in('id', successIds);
        if(failIds.length) await this.q('campaign_queue').update({ status: 'failed', updated_at: new Date() }).in('id', failIds);
    },
    async incrementStats(campId, sentDelta, failDelta) {
        const { data } = await this.q('campaigns').select('sent_count, failed_count').eq('id', campId).single();
        if(data) {
            await this.q('campaigns').update({ 
                sent_count: data.sent_count + sentDelta,
                failed_count: data.failed_count + failDelta
            }).eq('id', campId);
        }
    },

    // CONTROL
    async setCampaignStatus(id, status) { await this.q('campaigns').update({ status }).eq('id', id); },
    async getCampaigns() { const { data } = await this.q('campaigns').select('*').order('created_at', { ascending: false }).limit(50); return data || []; },
    async getActiveCampaign() { 
        const { data } = await this.q('campaigns').select('*').eq('status', 'running').order('created_at', { ascending: false }).limit(1).single(); 
        return data; 
    }
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

const CampBuilder = {
    addList() {
        const sel = document.getElementById('camp-source-list');
        if(!sel.value) return;
        const text = sel.options[sel.selectedIndex].text;
        State.campBuilder.lists.push({ id: sel.value, name: text });
        this.renderTags();
        sel.value = "";
    },
    removeList(idx) {
        State.campBuilder.lists.splice(idx, 1);
        this.renderTags();
    },
    renderTags() {
        const area = document.getElementById('camp-sources-area');
        if(!State.campBuilder.lists.length) { area.innerHTML = `<span class="text-[10px] text-slate-400 self-center italic pl-2">No lists selected.</span>`; return; }
        area.innerHTML = State.campBuilder.lists.map((l, i) => 
            `<span class="bg-brand-100 text-brand-700 px-2 py-1 rounded text-[10px] font-bold flex items-center gap-1">
                ${l.name} <button onclick="CampBuilder.removeList(${i})" class="hover:text-red-600"><i data-lucide="x" class="w-3 h-3"></i></button>
            </span>`
        ).join('');
    }
};

const Engine = {
    handleFile(i) { if(i.files[0]) { document.getElementById('file-name').innerText = i.files[0].name; CoreUtils.processFile(i.files[0]).then(f => State.activeFile = f); } },

    async compileAndLaunch() {
        const name = document.getElementById('camp-name').value || `Campaign ${new Date().toLocaleTimeString()}`;
        const msg = document.getElementById('camp-msg').value;
        const manual = document.getElementById('camp-manual-input').value;

        const numberSet = new Set();
        const manualNums = manual.match(/\d{10,}/g) || [];
        manualNums.forEach(n => numberSet.add(n));

        for (const list of State.campBuilder.lists) {
            Utils.toast(`Fetching list: ${list.name}...`);
            const content = await DataStore.getListContent(list.id);
            if(content && content.contacts) content.contacts.forEach(c => numberSet.add(c.number));
        }

        const uniqueNumbers = Array.from(numberSet);
        if(!uniqueNumbers.length) return Utils.toast("No valid numbers found!", "error");

        Utils.toast(`Queueing ${uniqueNumbers.length} unique items...`, "info");
        const campId = await DataStore.createCampaign(name, msg, uniqueNumbers.length, State.activeFile);
        if(!campId) return Utils.toast("Database Error", "error");

        await DataStore.addToQueue(campId, uniqueNumbers);
        await DataStore.setCampaignStatus(campId, 'running'); 

        State.campBuilder.lists = []; 
        CampBuilder.renderTags();
        document.getElementById('camp-manual-input').value = "";
        
        Utils.toast("Launched! Monitor Active.", "success");
        UI.setCampTab('monitor');
        if(!State.engine.running) this.poll();
    },

    async poll() {
        if(State.engine.running) return; 
        State.engine.running = true;

        const monitorName = document.getElementById('monitor-camp-name');
        const monitorBadge = document.getElementById('monitor-badge');
        const miniStatus = document.getElementById('engine-status-mini');

        const activeCamp = await DataStore.getActiveCampaign();
        
        if(!activeCamp) {
            State.engine.running = false;
            monitorName.innerText = "System Idle";
            monitorBadge.innerText = "WAITING";
            monitorBadge.className = "px-2 py-0.5 rounded bg-slate-200 text-[10px] font-bold text-slate-500";
            miniStatus.innerText = "IDLE";
            miniStatus.className = "text-[10px] font-bold text-slate-400";
            setTimeout(() => this.poll(), 3000); 
            return;
        }

        monitorName.innerText = activeCamp.name;
        monitorBadge.innerText = "RUNNING";
        monitorBadge.className = "px-2 py-0.5 rounded bg-emerald-100 text-[10px] font-bold text-emerald-600 animate-pulse";
        miniStatus.innerText = "ACTIVE";
        miniStatus.className = "text-[10px] font-bold text-emerald-600 animate-pulse";
        
        const batchSize = parseInt(State.settings.batch) || 10;
        const batch = await DataStore.getNextBatch(activeCamp.id, batchSize);

        if(!batch.length) {
            await DataStore.setCampaignStatus(activeCamp.id, 'completed');
            Utils.toast(`Campaign Finished!`, "success");
            State.engine.running = false;
            this.poll(); 
            return;
        }

        const successIds = [];
        const failIds = [];
        const bar = document.getElementById('batch-bar');

        Utils.log(`<div class="mt-2 text-slate-300">--- BATCH (${batch.length}) ---</div>`);

        for (let i = 0; i < batch.length; i++) {
            const item = batch[i];
            try {
                bar.style.width = `${((i+1)/batch.length)*100}%`;
                await Api.req('send', { 
                    id: State.user, 
                    number: item.number, 
                    message: activeCamp.message, 
                    file: activeCamp.media_data ? { data: activeCamp.media_data, mimetype: activeCamp.media_mime, filename: activeCamp.media_name } : null 
                });
                successIds.push(item.id);
                Utils.log(`<div class="text-emerald-500 text-[10px] font-bold">> ${item.number} [OK]</div>`);
            } catch(e) {
                failIds.push(item.id);
                Utils.log(`<div class="text-red-400 text-[10px] font-bold">> ${item.number} [ERR]</div>`);
            }
            await new Promise(r => setTimeout(r, Math.random() * 500 + 500));
        }

        await DataStore.batchUpdateStatus(successIds, failIds);
        await DataStore.incrementStats(activeCamp.id, successIds.length, failIds.length);
        
        document.getElementById('monitor-success').innerText = (parseInt(document.getElementById('monitor-success').innerText)||0) + successIds.length;
        document.getElementById('monitor-fail').innerText = (parseInt(document.getElementById('monitor-fail').innerText)||0) + failIds.length;

        State.engine.running = false;
        const cool = parseInt(State.settings.cool) || 60;
        
        let cd = cool;
        const timer = setInterval(() => { monitorBadge.innerText = `COOLING ${cd}s`; cd--; if(cd <= 0) clearInterval(timer); }, 1000);
        setTimeout(() => this.poll(), cool * 1000);
    },

    async toggleCamp(id, currentStatus) {
        const newStatus = currentStatus === 'running' ? 'paused' : 'running';
        await DataStore.setCampaignStatus(id, newStatus);
        this.refreshCampaigns();
        if(newStatus === 'running') this.poll(); 
    },

    async refreshCampaigns() {
        const tbody = document.getElementById('history-table-body');
        tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-xs text-slate-400">Loading...</td></tr>';
        const camps = await DataStore.getCampaigns();
        tbody.innerHTML = '';
        if(!camps.length) { tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-xs text-slate-400">No History</td></tr>'; return; }
        
        camps.forEach(c => {
            const row = document.createElement('tr');
            row.className = "border-b border-slate-50 hover:bg-slate-50";
            let statusBadge = "";
            if(c.status === 'running') statusBadge = `<span class="bg-emerald-100 text-emerald-700 px-2 py-1 rounded text-[10px] font-bold animate-pulse">RUNNING</span>`;
            else if(c.status === 'paused') statusBadge = `<span class="bg-amber-100 text-amber-700 px-2 py-1 rounded text-[10px] font-bold">PAUSED</span>`;
            else statusBadge = `<span class="bg-slate-100 text-slate-500 px-2 py-1 rounded text-[10px] font-bold uppercase">${c.status}</span>`;

            const percent = c.total_count > 0 ? Math.round(((c.sent_count + c.failed_count) / c.total_count) * 100) : 0;
            row.innerHTML = `<td class="px-6 py-4"><div class="font-bold text-xs text-slate-800">${c.name}</div><div class="text-[10px] text-slate-400">${new Date(c.created_at).toLocaleDateString()}</div></td><td class="px-6 py-4"><div class="w-full bg-slate-200 h-1.5 rounded-full mb-1"><div class="h-full bg-brand-500 rounded-full" style="width: ${percent}%"></div></div><div class="text-[10px] text-slate-500 font-mono">${c.sent_count}/${c.total_count}</div></td><td class="px-6 py-4">${statusBadge}</td><td class="px-6 py-4 text-right">${c.status !== 'completed' ? `<button onclick="Engine.toggleCamp('${c.id}', '${c.status}')" class="text-[10px] font-bold border px-3 py-1.5 rounded transition-colors ${c.status==='running' ? 'border-amber-200 text-amber-600 bg-amber-50 hover:bg-amber-100' : 'border-emerald-200 text-emerald-600 bg-emerald-50 hover:bg-emerald-100'}">${c.status==='running' ? 'PAUSE' : 'RESUME'}</button>` : '<span class="text-slate-300 text-[10px]">--</span>'}</td>`;
            tbody.appendChild(row);
        });
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
        const sel = document.getElementById('camp-source-list');
        const grid = document.getElementById('contact-grid');
        const lists = await DataStore.getLists();
        
        if(sel) {
            sel.innerHTML = '<option value="">Select a Cloud List...</option>';
            lists.forEach(l => { const opt = document.createElement('option'); opt.value = l.id; opt.innerText = `${l.name} (${l.count})`; sel.appendChild(opt); });
        }
        
        if(grid) {
            grid.innerHTML = '';
            lists.forEach(l => {
                const div = document.createElement('div');
                div.className = "flex justify-between items-center p-3 bg-slate-50 border border-slate-200 rounded-lg hover:border-slate-300 transition-colors";
                div.innerHTML = `<div><p class="text-xs font-bold text-slate-700">${l.name}</p><p class="text-[10px] text-slate-400">${l.count} items</p></div><div class="flex gap-1"><button onclick="CoreUtils.exportCSV('${l.name}', DataStore.getListContent('${l.id}'))" class="p-1.5 bg-white border border-slate-200 rounded text-slate-400 hover:text-green-600"><i data-lucide="download" class="w-3 h-3"></i></button><button onclick="ContactManager.loadToSelect('${l.id}')" class="p-1.5 bg-white border border-slate-200 rounded text-slate-400 hover:text-brand-600"><i data-lucide="check-square" class="w-3 h-3"></i></button><button onclick="Database.openEdit('${l.id}')" class="p-1.5 bg-white border border-slate-200 rounded text-slate-400 hover:text-blue-600"><i data-lucide="pencil" class="w-3 h-3"></i></button><button onclick="Database.delete('${l.id}')" class="p-1.5 bg-white border border-slate-200 rounded text-slate-400 hover:text-red-500"><i data-lucide="trash" class="w-3 h-3"></i></button></div>`;
                grid.appendChild(div);
            });
        }
        
        const statStored = document.getElementById('stat-stored');
        if(statStored) statStored.innerText = lists.length;
        lucide.createIcons();
    },
    async delete(id) { if(confirm("Delete Cloud List?")) { await DataStore.deleteList(id); this.render(); } },
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
    setCampTab(tab) {
        ['launch', 'monitor', 'history'].forEach(t => {
            const p = document.getElementById(`panel-camp-${t}`);
            const b = document.getElementById(`tab-camp-${t}`);
            if(t === tab) {
                p.classList.remove('hidden');
                b.classList.add('bg-white', 'shadow-sm', 'text-slate-800');
                b.classList.remove('text-slate-500');
                if(tab === 'history') Engine.refreshCampaigns();
            } else {
                p.classList.add('hidden');
                b.classList.remove('bg-white', 'shadow-sm', 'text-slate-800');
                b.classList.add('text-slate-500');
            }
        });
    },
    setContactTab(tab) {
        const list = document.getElementById('cont-panel-list'), tools = document.getElementById('cont-panel-tools');
        const btnList = document.getElementById('tab-list'), btnTools = document.getElementById('tab-tools');
        if(tab === 'list') { list.classList.remove('hidden'); tools.classList.add('hidden'); btnList.classList.add('bg-white','shadow-sm','text-slate-800'); btnTools.classList.remove('bg-white','shadow-sm','text-slate-800'); } 
        else { list.classList.add('hidden'); tools.classList.remove('hidden'); tools.classList.add('flex'); btnTools.classList.add('bg-white','shadow-sm','text-slate-800'); btnList.classList.remove('bg-white','shadow-sm','text-slate-800'); }
    }
};

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
