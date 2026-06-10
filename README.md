# Main Financial Tracker

## 🚀 Features

- **Authentication Layer:** Secure login and registration powered by Supabase Auth with automated user profile provisioning.
- **Unified Net Worth Dashboard:** Real-time conversion matrix calculating local liquid wallets, unpaid credit statements, digital/physical assets, and outstanding debts into your preferred global Base Currency (default: `IDR`).
- **Pockets & Credit Tracker:** Separate views for liquid cash and credit cards. Includes a dynamic, non-mutating "Est. Monthly Interest" display for credit limits.
- **Hierarchical Tree Categories:** Recursive multi-level expense/income structures with soft-delete features to protect transaction histories.
- **Hybrid Assets Module:** Segregated view for physical and digital assets. Integrates with CoinGecko's keyless public API to lazy-load and sync live prices with built-in rate-limiting delays.
- **Dual-System Debts Tracker:** Handles standard fiat financial obligations alongside volume-based commodity tracking (e.g., gold grams) with active asset pricing valuation.
- **Central Ledger Engine:** Polymorphic data logging system executing multi-table data mutations wrapped inside atomic PostgreSQL database stored procedures (RPC) to prevent ledger drift.

---

## 🛠 Tech Stack

- **Frontend:** Pure HTML5, Semantic CSS3, Tailwind CSS (via CDN)
- **Logic:** Modern Vanilla JavaScript (ES6+ Native Modules)
- **Backend/Database:** Supabase Ecosystem (`@supabase/supabase-js` via CDN)
- **Data Integration:** - ExchangeRate-API (Keyless client-side engine for global currency conversions)
  - CoinGecko API v3 (Public free tier tracker for digital assets)

---

## ⚙️ Project Architecture

The client application utilizes a strict modular **ES Module (`type="module"`)** architecture:

```text
├── index.html               # Main markup skeleton & view shell panes
├── styles.css               # Swiss-style minimalist layout adjustments & overrides
├── js/
│   ├── app.js               # Central orchestrator, hash-routing, and state container
│   ├── supabase.js          # Client initialization & direct RPC transaction bindings
│   ├── currency.js          # Live rate synchronization, cache, and conversion matrix
│   └── components/          # Standalone UI rendering engines
│       ├── dashboard.js
│       ├── accounts.js
│       ├── categories.js
│       ├── assets.js
│       ├── debts.js
│       └── logs.js

```

---

## ⚡ Setup & Installation

### 1. Database Setup (Supabase)

1. Create a new project in your **Supabase Dashboard**.
2. Navigate to the **SQL Editor** tab from the sidebar.
3. Paste the provided database initialization script containing table definitions, Row-Level Security (RLS) configurations, and the required atomic stored procedures (RPCs).
4. Click **Run**.

### 2. Client Configuration

Open your project files and locate `js/supabase.js`. Replace the placeholder variables with your project credentials:

```javascript
const SUPABASE_URL = "[https://your-project-id.supabase.co](https://your-project-id.supabase.co)";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."; // Safe to expose publicly with RLS enabled

```

### 3. Running Locally

Because this project utilizes native JavaScript ES Modules, opening `index.html` directly in a browser via the file system (`file:///`) will trigger CORS blockages.

You must serve it through a local development server:

* **VS Code:** Install the **Live Server** extension, right-click `index.html`, and select *Open with Live Server*.
* **Python:** Run `python -m http.server 8000` inside the root directory.
* **Node.js:** Run `npx serve` or `npm install -g serve`.

---

## 🔒 Security

* All read/write tables enforce **Row-Level Security (RLS)** using `auth.uid() = user_id`.
* The `ANON_PUBLIC_KEY` configured on the client is restricted to scoped user operations and cannot bypass safety checkpoints.
* Ledger records (`logs`) have direct mutation vectors blocked on a client interface level; edits or additions can only occur via internal PostgreSQL execution routines.

```
