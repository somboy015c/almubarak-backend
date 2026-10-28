# Elmubarak Digital Hub: Backend

Node.js / Express API for the VTU platform.

**Start with [SETUP-GUIDE.md](SETUP-GUIDE.md)**: the complete step-by-step procedure
(MongoDB, Render, domain, Resend, Arrifqubundle, Flutterwave, testing, going live).

- Providers: **Arrifqubundle** (services), **Flutterwave** (funding + withdrawals), **Resend** (email)
- Run locally: `npm install`, copy `.env.example` to `.env`, fill in `MONGODB_URI` and `JWT_SECRET`, then `npm run dev`.
  With `PROVIDER_MODE=mock` nothing external is needed except MongoDB.
- All settings are documented in `.env.example`.

```
server.js              entry point
routes/                auth, wallet, services, transactions, withdrawal, admin, webhooks, ...
services/arrifqubundle.js  Arrifqubundle: purchases, verification, requery, balance, diagnostics
services/flutterwave.js Flutterwave: checkout, banks, account lookup, payouts
services/email.js      Resend emails (verification + reset)
services/funding.js    credits a payment exactly once (browser + webhook safe)
services/settle.js     settles slow orders (refund only when the provider confirms failure)
services/orders.js     runs a purchase (wallet debit, provider, refund) and starts pay-with-Flutterwave orders
models/Settings.js     admin switches (services, networks, plans, maintenance, notice)
models/Log.js          activity log (auto-deleted after 90 days)
```
