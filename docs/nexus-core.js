/**
 * NEXUS CORE v3.1 | CONTROLLER
 * Handles State, Database, API, and Execution Loop.
 */

// Global State Container
const State = { 
    user: 'client-1', 
    running: false, 
    activeCamp: null, 
    file: null, 
    queue: [], 
    contacts: [], 
    settings: { batch: 10, cool: 60 } 
};

// Central Utilities (Logger & Toast)
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
    log: (msg, type='info') => { 
        const l = document.getElementById('console-logs');
        if(!l) return;
        l.innerHTML = `<div class="${type=='err'?'text-red-500':'text-slate-500'} border-l-2 ${type=='success'?'border-emerald-500':'border-slate-200'} pl-2 text-[10px] py-0.5">> ${msg}</div>` + l.innerHTML; 
    }
};

// Database Abstraction Layer (Supabase)
const DataStore = {
    async query(table, action, payload={}, match={}) {
        if(!window.db) return null;
        let q = window.db.from(table);
        if(action === 'select') q = q.select(payload);
        if(action === 'insert') q = q.insert(payload);
        if(action === 'update') q = q.update(payload);
        if(action === 'delete') q = q.delete();
        
        Object.keys(match).forEach(k => q = q.eq(k, match[k]));
        
        const { data, error } = await q;
        if(error) console.error("DB Error", error);
        return error ? null : data;
    },
    async getQueue(cID) { 
        // Fetch pending items for specific campaign
        return await this.query('campaign_queue', 'select', 'id, number', { campaign_id: cID, status: 'pending' }); 
    }
};

// API Wrapper
const Api = {
    async req(ep, body) { 
        try { 
            const r = await fetch(`${window.CONFIG.API_BASE}/api/${ep}`, body ? { 
                method: 'POST', 
                headers: {'Content-Type':'application/json'}, 
                body: JSON.stringify(body) 
            } : {}); 
            return r.ok ? await r.json() : null; 
        } catch(e) { return null; } 
    }
};

// Main Execution Engine
const Engine = {
    async start(campName, nums, msg) {
        if(!nums || !nums.length) return Utils.toast("No valid numbers found", "err");
        
        Utils.toast("Initializing Campaign...", "info");

        // 1. Create Campaign in DB
        const camp = await DataStore.query('campaigns', 'insert', { 
            name: campName || `Camp ${new Date().toLocaleTimeString()}`, 
            message: msg, 
            total_count: nums.length, 
            status: 'running' 
        }).then(d => d && d[0]);
        
        if(!camp) return Utils.toast("Database Write Failed", "err");
        
        State.activeCamp = camp.id;
        this.updateDisplay(camp.id);
        
        // 2. Persist Queue (Bulk Insert)
        Utils.toast(`Queueing ${nums.length} contacts...`, "info");
        const rows = nums.map(n => ({ campaign_id: camp.id, number: n, status: 'pending' }));
        
        // Chunk insert to respect DB limits
        const chunkSize = 500; 
        for (let i = 0; i < rows.length; i += chunkSize) {
            await DataStore.query('campaign_queue', 'insert', rows.slice(i, i + chunkSize));
        }

        Utils.toast("Engine Started", "success");
        this.toggle(true);
    },

    async process() {
        if(!State.running || !State.activeCamp) return;
        
        // Fetch next batch dynamically
        const limit = parseInt(State.settings.batch) || 10;
        const allPending = await DataStore.getQueue(State.activeCamp);
        const batch = allPending ? allPending.slice(0, limit) : [];
        
        if(!batch.length) {
            await DataStore.query('campaigns', 'update', { status: 'completed' }, { id: State.activeCamp });
            Utils.toast("Campaign Finished", "success");
            return this.toggle(false);
        }

        Utils.log(`Processing Batch (${batch.length})`, 'info');
        
        // Execute Batch
        for(const item of batch) {
            if(!State.running) break;
            
            // Dynamic check for message content (allows live editing)
            const liveMsg = document.getElementById('camp-msg') ? document.getElementById('camp-msg').value : "";
            
            const res = await Api.req('send', { 
                id: State.user, 
                number: item.number, 
                message: liveMsg, 
                file: State.file 
            });
            
            const status = res ? 'sent' : 'failed';
            
            // Atomic Status Update
            await DataStore.query('campaign_queue', 'update', { status }, { id: item.id });
            
            // UI Stats Update
            const statEl = document.getElementById(status === 'sent' ? 'stat-sent' : 'stat-stored');
            if(statEl) statEl.innerText = (parseInt(statEl.innerText) || 0) + 1;
            
            Utils.log(`${item.number} > ${status.toUpperCase()}`, status === 'sent' ? 'success' : 'err');
            
            // Jitter Delay (Anti-Ban)
            await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000));
        }

        // Cooldown Loop
        if(State.running) {
            const cool = parseInt(State.settings.cool) || 60;
            Utils.log(`Cooldown: ${cool}s...`);
            setTimeout(() => this.process(), cool * 1000);
        }
    },

    toggle(forceState) {
        State.running = forceState !== undefined ? forceState : !State.running;
        const btn = document.getElementById('btn-engine-toggle');
        if(btn) btn.innerText = State.running ? "PAUSE" : "RESUME";
        
        const indicator = document.getElementById('queue-mini');
        if(indicator) indicator.innerText = State.running ? "RUNNING" : "IDLE";
        
        if(State.running) this.process();
    },

    updateDisplay(id) {
        const el = document.getElementById('active-camp-display');
        if(el) el.innerText = id ? `ID: ${id.slice(0,8)}...` : "IDLE";
    },

    async checkRecovery() {
        // Auto-Recovery on Page Load
        const active = await DataStore.query('campaigns', 'select', '*', { status: 'running' });
        if(active && active.length) {
            if(confirm(`Nexus found an interrupted campaign "${active[0].name}". Resume it?`)) {
                State.activeCamp = active[0].id;
                this.updateDisplay(active[0].id);
                
                const msgInput = document.getElementById('camp-msg');
                if(msgInput) msgInput.value = active[0].message;
                
                Utils.toast("State Recovered. Click RESUME.", "success");
            }
        }
    }
};

// Session & Connection Manager
const Session = {
    async check() {
        const res = await Api.req(`status/${State.user}`);
        const dot = document.getElementById('conn-dot');
        const qrCanvas = document.getElementById('qr-canvas');
        const qrModal = document.getElementById('modal-qr');
        
        if(!dot) return;

        if(res?.status === 'READY') { 
            dot.className = "w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]"; 
            if(qrModal) qrModal.classList.add('hidden');
        }
        else if(res?.status === 'QR_READY') { 
            dot.className = "w-2 h-2 rounded-full bg-blue-500 animate-pulse"; 
            // Auto-show QR if we have the library loaded
            if(res.qr && window.QRious && qrCanvas) {
                new QRious({ element: qrCanvas, value: res.qr, size: 200 });
            }
        }
        else { 
            dot.className = "w-2 h-2 rounded-full bg-slate-300"; 
        }
    }
};
