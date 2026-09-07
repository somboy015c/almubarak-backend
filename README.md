# Almubarak Digital Hub — VTU Platform

A full web app for selling airtime, data bundles, electricity bills, cable TV
subscriptions and exam PINs, with user accounts, a wallet system, and an
admin panel.

- **`/server`** — Node.js/Express API. Deploy this to **Render**.
- **`/client`** — Plain HTML/CSS/JS frontend. No build step, deploy this to
  **GitHub Pages** (or any static host).

**Database:** this app uses **MongoDB** so your data survives redeploys and
Render's free-tier restarts. You need a free MongoDB Atlas cluster before
the backend will start — see the next section.

## 0. Set up your free database (MongoDB Atlas)

1. Go to **https://www.mongodb.com/cloud/atlas/register** and create a free account.
2. Create a new cluster — pick the **free M0 tier** (no credit card needed).
3. Under **Database Access**, create a database user with a username and password.
4. Under **Network Access**, add `0.0.0.0/0` (allow access from anywhere) — needed
   since Render's outgoing IP isn't fixed on the free tier.
5. Once the cluster is ready, click **Connect** → **Drivers**, copy the connection
   string. It looks like:
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. Replace `<username>` and `<password>` with the database user you created, and
   add a database name before the `?`, e.g. `.../almubarak?retryWrites=true...`.
7. Put that full string in `MONGODB_URI` in your `.env` (locally) and in Render's
   Environment tab (in production).

---

## 1. Run it locally

### Backend
```bash
cd server
npm install
cp .env.example .env
# open .env and set:
#   - MONGODB_URI to your Atlas connection string (see step 0 above)
#   - JWT_SECRET to any long random string
npm run dev
```
The API starts on `http://localhost:5000`. It ships in **mock mode**: fully
working end-to-end (register, fund wallet, buy airtime/data/electricity/
cable/exam PINs, admin panel) with **no VTpass/Paystack accounts required** —
only the database is a real external service now.

### Frontend
The frontend is static — no build tools needed. Easiest way to serve it
locally so `fetch()` calls work correctly:
```bash
cd client
npx serve .
# or: python3 -m http.server 5500
```
Open the printed URL (e.g. `http://localhost:5500`) in your browser.
`client/js/config.js` already points at `http://localhost:5000/api` by default.

### Try it out
1. Go to **Create account**, register with any email/phone/password.
2. The **first account you register becomes the admin automatically**
   (see `ADMIN_EMAIL` in `.env` for an alternative way to designate one).
3. Go to **Fund wallet**, enter an amount — in mock mode this credits
   instantly with no real payment.
4. Try Airtime, Data, Electricity, Cable TV, Exam PINs — all work against
   realistic mock data and debit your wallet.
5. Visit **Admin panel** (only visible to the admin account) to see all
   users, all transactions, adjust wallets, and change markup/pricing.

---

## 2. How mock mode works

Every purchase and payment goes through `server/services/vtpass.js` and
`server/services/paystack.js`. With `PROVIDER_MODE=mock` (the default),
these files simulate provider responses instead of calling real APIs, so
the whole app — UI, wallet debits, transaction history, admin stats — is
fully exercised without any third-party account.

Nothing else in the app needs to change when you go live: routes, the
database, and the frontend all talk to these two files, not to VTpass or
Paystack directly.

---

## 3. Going live: getting your API keys

### VTpass (delivers the actual airtime/data/electricity/cable/exam PINs)
1. Create a business account at **https://vtpass.com**.
2. Complete their KYC/business verification — required before you can
   sell to real customers.
3. In their dashboard, grab your **sandbox** API key, secret key and
   public key first, and test against `https://sandbox.vtpass.com/api`.
4. Fund your VTpass wallet (this is what actually pays for the airtime/data
   you resell).
5. When ready, switch to live keys and `https://vtpass.com/api`.
6. VTpass also has other Nigerian competitors with a very similar API shape
   if you prefer them: **Baxi**, **ClubKonnect**, **ChapsVTU** — the
   `server/services/vtpass.js` file is where you'd point requests at
   whichever provider you choose.

### Paystack (collects real money to fund customer wallets)
1. Create an account at **https://paystack.com**.
2. Complete their business verification.
3. Copy your **test** secret/public keys first and confirm the funding flow
   end-to-end.
4. Switch to **live** keys once you're ready to accept real customer money.
   (Flutterwave is a common alternative with a similar API if you'd rather
   use that — swap it in inside `server/services/paystack.js`.)

### Switch the app to live mode
In `server/.env`:
```
PROVIDER_MODE=live
VTPASS_BASE_URL=https://vtpass.com/api
VTPASS_API_KEY=...
VTPASS_SECRET_KEY=...
PAYSTACK_SECRET_KEY=...
PAYSTACK_PUBLIC_KEY=...
```
Redeploy the backend after changing these.

---

## 4. Deploying the backend to Render

1. Push this repo to GitHub.
2. On **render.com** → New → Web Service → connect your repo.
3. Root directory: `server`
4. Build command: `npm install`
5. Start command: `npm start`
6. Add all the environment variables from `.env.example` under Render's
   "Environment" tab (use a fresh, random `JWT_SECRET`).
7. Set `CLIENT_ORIGIN` to your GitHub Pages URL, e.g.
   `https://yourusername.github.io`.
8. Deploy. Note the URL Render gives you, e.g.
   `https://almubarak-vtu-api.onrender.com`.

**On data persistence:** since the app now uses MongoDB Atlas rather than a
local file, your users, transactions, and wallet balances survive every
redeploy and every free-tier spin-down/spin-up cycle — nothing resets
unless you explicitly delete data from Atlas.

---

## 5. Deploying the frontend to GitHub Pages

1. In `client/js/config.js`, change the URL to your live Render backend:
   ```js
   window.API_BASE_URL = 'https://almubarak-vtu-api.onrender.com/api';
   ```
2. Push the repo to GitHub.
3. Repo → Settings → Pages → Source: deploy from branch → select your
   branch and the `/client` folder (or move `client`'s contents to a
   `docs/` folder or `gh-pages` branch, whichever GitHub Pages setup you
   prefer).
4. Your app will be live at `https://yourusername.github.io/your-repo/`.

---

## 6. Project structure

```
vtu-app/
├── server/
│   ├── server.js              Express app entry point
│   ├── config/db.js           MongoDB connection (mongoose)
│   ├── models/                Mongoose schemas: User, Transaction, Funding, Pricing
│   ├── middleware/auth.js     JWT auth + admin guard
│   ├── routes/
│   │   ├── auth.js            register / login / me
│   │   ├── wallet.js          fund wallet (Paystack)
│   │   ├── services.js        airtime / data / electricity / cable / exam
│   │   ├── transactions.js    a user's own transaction history
│   │   └── admin.js           stats, users, all transactions, pricing
│   ├── services/
│   │   ├── vtpass.js          VTU provider integration (mock + live)
│   │   └── paystack.js        payment gateway integration (mock + live)
│   └── .env.example
└── client/
    ├── index.html             marketing landing page
    ├── login.html / register.html
    ├── dashboard.html         user app (SPA-style, one page + JS views)
    ├── admin.html             admin panel
    ├── css/style.css
    └── js/
        ├── config.js          API_BASE_URL — edit this after deploying
        ├── api.js             fetch wrapper + session handling
        ├── dashboard.js
        └── admin.js
```

---

## 7. Security notes before accepting real money

- Rotate `JWT_SECRET` to a long random value in production
  (`openssl rand -hex 32`).
- Put the backend behind HTTPS (Render does this for you automatically).
- Set `CLIENT_ORIGIN` to your real frontend domain(s) only — don't leave it
  open to all origins in production.
- Consider adding request logging and a proper database with backups before
  handling real customer funds.
- VTpass and Paystack both support webhook callbacks — for production,
  handling their webhooks (rather than only trusting the browser's
  "verify" call) makes the flow more robust against interrupted connections.
