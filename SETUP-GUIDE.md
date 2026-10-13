# Elmubarak Digital Hub: Complete Setup Guide

This guide takes you from the zip files to a live site at **https://elmubarak.com.ng**.
Do the parts **in order**. Each part says what you'll have at the end.

**How the pieces fit**

| Piece | Service | Role |
|---|---|---|
| Website (frontend) | GitHub Pages | Serves `elmubarak.com.ng` |
| API (backend) | Render | Runs the Node server |
| Database | MongoDB Atlas | Users, wallets, transactions |
| Emails | Resend | Verification + password-reset emails |
| Airtime / data / bills / exam PINs | VTpass | Delivers what customers buy |
| Wallet funding + withdrawals | Flutterwave | Takes customer payments, pays out to banks |

**Three stages, one switch.** `PROVIDER_MODE` in the backend settings controls everything:

1. `mock`: nothing external is called. Safe for trying the app. (Emails are printed in the server log.)
2. `live` + **VTpass sandbox URL + Flutterwave TEST keys**: real integration, fake money. Do this before going live.
3. `live` + **VTpass live URL + Flutterwave LIVE keys**: real money.

---

## Part 1: MongoDB Atlas (database)

1. Create a free account at https://www.mongodb.com/cloud/atlas/register and create a free **M0** cluster.
2. **Database Access** -> add a user (username + password). Save them.
3. **Network Access** -> add `0.0.0.0/0` (Render's IPs change, so Atlas must accept any).
4. **Connect** -> **Drivers** -> copy the connection string and put a database name before the `?`:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/elmubarak?retryWrites=true&w=majority`
   This is your `MONGODB_URI`.

---

## Part 2: Deploy the backend on Render

1. Put the backend folder in a GitHub repository (for example `almubarak-backend`).
2. On https://render.com -> **New** -> **Web Service** -> connect that repo.
3. Settings: **Build command** `npm install`, **Start command** `npm start`.
4. Add these **Environment variables** (you'll fill the blanks in later parts, and can come back):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `MONGODB_URI` | from Part 1 |
| `JWT_SECRET` | a long random string (run `openssl rand -hex 32`) |
| `PROVIDER_MODE` | start with `mock` |
| `CLIENT_ORIGIN` | `https://elmubarak.com.ng,https://www.elmubarak.com.ng` |
| `FRONTEND_URL` | `https://elmubarak.com.ng` |
| `ADMIN_EMAIL` | the email you'll register as admin with |
| `RESEND_API_KEY` | Part 4 |
| `EMAIL_FROM` | `Elmubarak Digital Hub <no-reply@elmubarak.com.ng>` |
| `VTPASS_BASE_URL` | `https://sandbox.vtpass.com/api` (later `https://vtpass.com/api`) |
| `VTPASS_API_KEY`, `VTPASS_PUBLIC_KEY`, `VTPASS_SECRET_KEY` | Part 5 |
| `VTPASS_LOW_BALANCE_ALERT` | `10000` (admin warning threshold, in naira) |
| `FLW_SECRET_KEY`, `FLW_PUBLIC_KEY` | Part 6 |
| `FLW_SECRET_HASH` | a random string you make up (`openssl rand -hex 24`) |
| `API_PUBLIC_URL` | your Render URL, e.g. `https://almubarak-backend.onrender.com` |

5. Click **Deploy**. When it's up, open `https://YOUR-RENDER-URL/api/health`. You should see `{"status":"ok",...}`.

> **Free tier note:** Render's free plan sleeps after inactivity, so the first request can take ~30-60 seconds
> and a payment/VTpass webhook may arrive late. That's fine for testing; for real customers use a paid
> instance so the API is always awake.

---

## Part 3: Deploy the website and connect your domain

### 3a. Frontend code
1. Open `js/config.js` in the frontend and set your backend URL:
   ```js
   window.API_BASE_URL = 'https://YOUR-RENDER-URL/api';
   ```
2. Push the frontend folder to a GitHub repo. The `CNAME` file already contains `elmubarak.com.ng`.
3. Repo -> **Settings** -> **Pages** -> deploy from the `main` branch (root). Under **Custom domain** enter
   `elmubarak.com.ng`, then tick **Enforce HTTPS** once it becomes available.

### 3b. DNS records (at wherever you manage elmubarak.com.ng DNS)
Add these:

| Type | Host | Value |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `YOUR-GITHUB-USERNAME.github.io` |

DNS can take from a few minutes to a few hours. (Resend adds its own records in Part 4; they don't conflict with these.)

*Optional but recommended later:* give the API a clean address like `api.elmubarak.com.ng`: in Render ->
**Settings** -> **Custom Domains** add it, create the CNAME Render tells you, then update `API_BASE_URL`
and `API_PUBLIC_URL`.

---

## Part 4: Resend (verification + password-reset emails)

1. Sign up at https://resend.com.
2. **Domains** -> **Add Domain** -> `elmubarak.com.ng` (region closest to Nigeria's users, e.g. Ireland/EU).
3. Resend shows several DNS records (an SPF TXT, a DKIM TXT, and an MX for the sending subdomain). Add **exactly** those at your DNS provider.
   Click **Verify**. Wait until the status is **Verified** (minutes to hours).
4. **API Keys** -> **Create API Key** (permission: *Sending access*, domain: elmubarak.com.ng). Copy it. It's shown once.
5. Put it in Render as `RESEND_API_KEY`, and keep `EMAIL_FROM` on the verified domain.

Until the domain is verified, Resend only delivers to your own account email. That's the #1 reason "emails don't arrive".

---

## Part 5: VTpass (airtime, data, electricity, cable, exam PINs)

### 5a. Sandbox first (free, fake money)
1. Create a **sandbox** account at https://sandbox.vtpass.com (separate from the live site).
2. **Profile** -> **API Settings**: copy the **API Key**, **Public Key** and **Secret Key**.
3. In Render set `VTPASS_BASE_URL=https://sandbox.vtpass.com/api` and the three keys.
   VTpass's documentation lists sandbox test phone numbers/meters for success and failure cases.

### 5b. Live
1. Create/verify a business account at https://vtpass.com (complete their KYC).
2. **Fund your VTpass wallet.** This is the money that actually pays for what customers buy.
3. **Profile** -> **API Settings**: copy the **live** keys (different from sandbox) and **whitelist your server's IP**
   (VTpass rejects live calls from unknown IPs). Render lists your service's **outbound IP addresses** in the service's
   *Connect* menu. Add all of them. If balance/purchases fail with a 401/403 after going live, this is almost always the cause.
4. In the same settings page set the **Webhook URL** to `https://YOUR-RENDER-URL/api/webhooks/vtpass`.
   (This lets slow orders settle automatically; the app also re-checks them itself.)
5. In Render change `VTPASS_BASE_URL` to `https://vtpass.com/api` and replace the keys with the live ones.

**Seeing the VTpass balance:** log in as admin -> **Admin panel** -> **Overview**. The **VTpass wallet balance** card shows your live VTpass balance
(with Refresh, an *Open VTpass dashboard* button, and a red warning below `VTPASS_LOW_BALANCE_ALERT`). Admins also see it at the top of their normal dashboard.

---

## Part 6: Flutterwave (wallet funding + withdrawals)

### 6a. Test mode first
1. Sign up at https://flutterwave.com and open the dashboard. Switch to **Test mode**.
2. **Settings** -> **API Keys**: copy the **test** Secret Key (`FLWSECK_TEST-...`) and Public Key into Render (`FLW_SECRET_KEY`, `FLW_PUBLIC_KEY`).
3. **Settings** -> **Webhooks**: set **URL** to `https://YOUR-RENDER-URL/api/webhooks/flutterwave`
   and **Secret hash** to the *same* value as `FLW_SECRET_HASH` in Render. Save.
   (The webhook credits wallets even if a customer closes the tab right after paying.)
4. Test with Flutterwave's test card from their docs (card `5531 8866 5214 2950`, expiry `09/32`, CVV `564`, PIN `3310`, OTP `12345`).

### 6b. Go live
1. Complete Flutterwave's business verification (KYC) so you can switch off test mode.
2. Copy the **live** keys into Render. Re-save the webhook URL + secret hash in **live** mode (test and live have separate settings).
3. **Withdrawals (payouts)** need extra setup on Flutterwave: Transfers/payouts enabled for your account, your Render **outbound IPs
   whitelisted** in API settings, and enough balance in your Flutterwave account to cover payouts. If a withdrawal fails, the customer is
   refunded automatically and the real reason is in your Render logs. Ask Flutterwave support if payouts are not enabled yet.
4. Check who pays the processing fee (Flutterwave's fee settings). Funding credits customers the exact amount they entered.

---

## Part 7: Admin account and pricing
1. Set `ADMIN_EMAIL` in Render, then **register with that exact email** on the website. The very first account is also made admin automatically.
2. Verify the email from the link you receive, then log in. You'll see the **Admin panel** in the sidebar.
3. Admin -> **Pricing & markup**: set your profit margins (airtime %, data %, electricity %, cable %, exam flat fee).
   All prices are calculated on the server, and customers see the final price before they confirm.

---

## Part 8: Test everything (do this before real money)

**Stage A: mock (`PROVIDER_MODE=mock`):**
- [ ] Register -> "Check your email" screen -> (email link is in the Render log in mock/no-key mode) -> verify -> log in.
- [ ] Log in before verifying -> blocked with a "Resend link" option.
- [ ] "Forgot password?" -> reset link -> new password -> log in. Eye icons work on every password field.
- [ ] Fund wallet, buy airtime/data/electricity/cable/exam. Receipt appears each time.
- [ ] Phone `00000000000` simulates a failure (wallet refunded); `11111111111` simulates a slow "processing" order.

**Stage B: sandbox/test (`PROVIDER_MODE=live` + sandbox URL + Flutterwave test keys):**
- [ ] Real verification email arrives from `no-reply@elmubarak.com.ng` (check spam once).
- [ ] Fund wallet with the test card -> redirected back -> balance credited.
- [ ] Buy data/airtime on VTpass sandbox; meter/smartcard verification returns a name.
- [ ] Admin Overview shows the VTpass sandbox balance.

**Stage C: production:** switch to live URL/keys (Parts 5b, 6b), fund VTpass, then do one small real purchase and one small real withdrawal before announcing.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Emails never arrive | Resend domain not **Verified** yet; wrong `RESEND_API_KEY`; check Render logs for "Resend error"; check spam |
| Verification link goes to wrong site | `FRONTEND_URL` wrong in Render |
| Browser shows CORS error | `CLIENT_ORIGIN` missing `https://elmubarak.com.ng` (and `www`) |
| "Could not reach the server" | `API_BASE_URL` in `js/config.js` wrong, or Render is waking up (free tier) |
| Admin balance card says VTpass rejected keys / IP | Wrong keys, sandbox keys on live URL (or vice versa), or Render outbound IPs not whitelisted on VTpass |
| Paid on Flutterwave but wallet not credited | Webhook URL/secret hash mismatch; wait a minute and refresh (the app also re-verifies); check logs |
| Withdrawal fails | Payouts not enabled / IPs not whitelisted / low Flutterwave balance. See Render logs |
| Orders stuck on "processing" | Normal for a few minutes; they settle automatically. Persisting >30 min: check VTpass transaction history and adjust the user's wallet in Admin |
| Customers see "service temporarily unavailable" | Your VTpass wallet is empty. Top it up |

## Security checklist before launch
- `JWT_SECRET` is long and random; `.env` is never committed to GitHub.
- `CLIENT_ORIGIN` lists only your real domains.
- Keys in Render are **live** keys only after testing is complete; never paste keys into chat/screenshots.
- Keep Render, Atlas, Resend, VTpass and Flutterwave logins protected with 2-factor authentication.
