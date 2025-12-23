# Nexus OS | Enterprise SaaS

**Nexus OS** is a lightweight, single-file frontend architecture designed for high-performance WhatsApp marketing and contact management. It features a zero-build environment, utilizing Tailwind CSS via CDN and vanilla JavaScript for a robust, "Enterprise-grade" experience directly in the browser.

## 🚀 Key Features

### 1. **Multi-Session Architecture**

* **Node Switching:** Seamlessly toggle between multiple WhatsApp sessions (Client 1 / Client 2) without reloading.
* **Global Memory:** Contacts synced from one session are retained in memory when switching nodes, allowing for the creation of "Master Lists" from multiple sources.

### 2. **Advanced Contact Management**

* **Hybrid Lists:** Merge contacts synced from WhatsApp with manually entered numbers.
* **Smart Deduplication:** Automatic duplicate removal using `Set` and `Map` data structures.
* **Persistent Selection:** Selection state is preserved across view changes.
* **CSV Export:** One-click export of saved lists to `.csv` format.

### 3. **Campaign Dispatcher**

* **Safety Protocol:** Configurable **Batch Size** and **Cool-down** timers to prevent number banning.
* **Media Support:** Send Images/Documents (auto-converts HEIC to JPG).
* **Real-time Console:** Live log of sending status (Pending, Sent, Failed).
* **Campaign History:** Local logs of previous campaigns for quick reference.

### 4. **Responsive UI/UX**

* **Mobile-First:** Tabbed interface for mobile devices (`Search` vs `Tools`).
* **Desktop Power:** Split-view layout for high productivity on larger screens.
* **Zero-CSS:** 100% styled using Tailwind Utility classes.

---

## 🛠️ Tech Stack

* **Core:** HTML5, Vanilla JavaScript (ES6+).
* **Styling:** Tailwind CSS (via CDN).
* **Icons:** Lucide Icons.
* **Utilities:** `QRious` (QR Code generation), `heic2any` (Image conversion).
* **Storage:** Browser `localStorage` (JSON-based persistence).

---

## 📦 Installation & Setup

Since Nexus OS is a **Single File Application (SFA)**, no `npm install` or build process is required.

1. **Download:** Save the provided code as `index.html`.
2. **Run:** Open the file directly in any modern browser (Chrome, Edge, Safari).
3. **Backend Connection:**
* The system is pre-configured to connect to: `https://mkwhatsapp.onrender.com`.
* *Note: Ensure the backend server is running for QR generation and Sending capabilities.*



---

## 📖 Usage Guide

### **1. Connecting a Session**

1. Open the Dashboard.
2. Select **Node 1** or **Node 2** from the sidebar.
3. Click **Initialize**.
4. If a session exists, the status becomes **READY**.
5. If not, click **Scan QR** and link your device via WhatsApp.

### **2. Managing Lists**

1. Go to the **Contacts** tab.
2. Click **Sync** to fetch numbers from the active WhatsApp session.
3. Select contacts by clicking them (or use the Search bar to filter).
4. **Create:** Enter a name in "List Manager" and click **Save**.
5. **Edit:** Click the **Edit (Pencil)** icon on a saved list to open the Manual Entry modal.
6. **Merge:** Click the **Select (Check-square)** icon on a list to load it into the selection, add new people, and Save again.

### **3. Sending a Campaign**

1. Go to the **Campaigns** tab.
2. **Target:** Select a saved list from the dropdown (automatically extracts numbers).
3. **Content:** Type your message and optionally attach a file.
4. Click **Add to Queue**.
5. Press **START** in the Dispatcher Console.
* *The engine will process messages based on the Settings configuration.*



---

## ⚙️ Configuration (Safety Mode)

Navigate to the **Config** tab to adjust the engine parameters:

| Setting | Default | Description |
| --- | --- | --- |
| **Batch Size** | 20 | Number of messages sent before pausing. |
| **Cool-down** | 60s | Duration of the pause between batches. |

---

## 🔮 Future Roadmap (v2.0)

* [ ] **Variable Templating:** Support for `{{name}}` in message bodies.
* [ ] **IndexedDB Support:** To handle lists larger than 5,000 contacts.
* [ ] **Cloud Sync:** Multi-user list sharing via Firebase/Supabase.
* [ ] **Analytics Dashboard:** Visual charts for delivery rates over time.

---

## ⚠️ Disclaimer

This tool is designed for **Enterprise Management** of own-lists. Sending unsolicited messages (SPAM) violates WhatsApp's Terms of Service. Use the "Safety Config" responsibly.

**License:** Proprietary / Internal Use Only.
