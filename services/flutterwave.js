// Flutterwave integration: wallet funding (Standard checkout), bank list,
// account-name lookup and bank payouts (withdrawals).
//
// PROVIDER_MODE=mock  -> no Flutterwave account needed; everything simulated.
// PROVIDER_MODE=live  -> real calls using FLW_SECRET_KEY.
//
// Docs: https://developer.flutterwave.com/docs  (API v3)

const axios = require('axios');
const { generateRef } = require('../utils/helpers');

const isLive = () => process.env.PROVIDER_MODE === 'live';
const { frontendUrl } = require('../utils/urls');

const client = () =>
  axios.create({
    baseURL: 'https://api.flutterwave.com/v3',
    timeout: 30000,
    headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json' }
  });

function logError(label, err) {
  console.error(`Flutterwave ${label}:`, err.response?.status, JSON.stringify(err.response?.data) || err.message);
}

// ---- Funding (collecting money in) ----

async function initializeFunding({ email, amount, name, phone }) {
  const reference = generateRef('FUND');

  if (!isLive()) {
    return { ok: true, reference, mock: true, authorization_url: null };
  }

  try {
    const { data } = await client().post('/payments', {
      tx_ref: reference,
      amount,
      currency: 'NGN',
      redirect_url: `${frontendUrl()}/dashboard.html?fund=1`,
      payment_options: 'card,banktransfer,ussd',
      customer: { email, name: name || email, phonenumber: phone || undefined },
      customizations: {
        title: 'Elmubarak Digital Hub',
        description: 'Wallet funding',
        logo: `${frontendUrl()}/assets/icon.png`
      }
    });
    const link = data?.data?.link;
    if (!link) return { ok: false, message: 'Could not start payment. Please try again.' };
    return { ok: true, reference, authorization_url: link };
  } catch (err) {
    logError('initialize', err);
    return { ok: false, message: 'Could not start payment. Please try again.' };
  }
}

// Returns { state: 'success' | 'pending' | 'failed' }.
// Success requires the right currency AND at least the expected amount.
async function verifyFunding(reference, expectedAmount) {
  if (!isLive()) return { state: 'success', mock: true };

  try {
    const { data } = await client().get('/transactions/verify_by_reference', { params: { tx_ref: reference } });
    const t = data?.data;
    if (!t) return { state: 'pending' };

    if (t.status === 'successful') {
      if (t.currency === 'NGN' && Number(t.amount) >= Number(expectedAmount)) return { state: 'success', raw: t };
      console.error(`Flutterwave amount mismatch for ${reference}: paid ${t.amount} ${t.currency}, expected ${expectedAmount}`);
      return { state: 'failed', raw: t };
    }
    if (t.status === 'failed') return { state: 'failed', raw: t };
    return { state: 'pending', raw: t };
  } catch (err) {
    // "No transaction was found" just means the customer hasn't paid (yet).
    if (err.response?.status === 404 || /no transaction/i.test(JSON.stringify(err.response?.data || ''))) {
      return { state: 'pending' };
    }
    logError('verify', err);
    return { state: 'pending' };
  }
}

// ---- Bank list ----

const MOCK_BANKS = [
  { name: 'Access Bank', code: '044' },
  { name: 'GTBank', code: '058' },
  { name: 'Zenith Bank', code: '057' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'UBA', code: '033' },
  { name: 'Kuda Bank', code: '50211' },
  { name: 'Opay', code: '999992' },
  { name: 'Palmpay', code: '999991' },
  { name: 'Moniepoint MFB', code: '50515' }
];

let bankCache = { at: 0, list: null };

async function listBanks() {
  if (!isLive()) return MOCK_BANKS;
  if (bankCache.list && Date.now() - bankCache.at < 6 * 60 * 60 * 1000) return bankCache.list;

  try {
    const { data } = await client().get('/banks/NG');
    const list = (data?.data || [])
      .map((b) => ({ name: b.name, code: b.code }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (list.length) bankCache = { at: Date.now(), list };
    return list.length ? list : MOCK_BANKS;
  } catch (err) {
    logError('banks', err);
    return bankCache.list || MOCK_BANKS;
  }
}

// ---- Account-name lookup ----

async function resolveAccount({ accountNumber, bankCode }) {
  if (!isLive()) return { ok: true, accountName: 'MOCK ACCOUNT NAME' };

  try {
    const { data } = await client().post('/accounts/resolve', {
      account_number: accountNumber,
      account_bank: bankCode
    });
    return { ok: true, accountName: data?.data?.account_name };
  } catch (err) {
    logError('resolve', err);
    return { ok: false, message: 'Could not verify that account number. Check the bank and number.' };
  }
}

// ---- Payouts ----
// NOT USED: withdrawals are paid manually by an admin (see routes/withdrawal.js).
// Kept only in case automatic payouts are wanted again later.
// Returns { ok, status: 'success' | 'pending' | 'failed', reference, providerRef }.

async function initiateTransfer({ amount, bankCode, accountNumber, accountName, reason }) {
  const reference = generateRef('PAYOUT');

  if (!isLive()) {
    await new Promise((r) => setTimeout(r, 500));
    return { ok: true, status: 'success', reference, providerRef: `MOCK-TRF-${Date.now()}` };
  }

  try {
    const { data } = await client().post('/transfers', {
      account_bank: bankCode,
      account_number: accountNumber,
      amount,
      currency: 'NGN',
      narration: reason || 'Elmubarak withdrawal',
      reference,
      beneficiary_name: accountName,
      callback_url: `${process.env.API_PUBLIC_URL || ''}/api/webhooks/flutterwave`
    });
    const s = String(data?.data?.status || '').toUpperCase();
    if (s === 'SUCCESSFUL') return { ok: true, status: 'success', reference, providerRef: String(data.data.id) };
    if (s === 'FAILED') return { ok: false, status: 'failed', reference, message: 'Payout could not be completed.' };
    // NEW / PENDING: Flutterwave is still processing; the webhook will settle it.
    return { ok: true, status: 'pending', reference, providerRef: String(data?.data?.id || '') };
  } catch (err) {
    logError('transfer', err);
    // Details (IP whitelist, balance, etc.) are logged for you, not shown to customers.
    return { ok: false, status: 'failed', reference, message: 'Payout could not be processed right now. You have not been charged.' };
  }
}


// ---- Flutterwave's own transaction list (what you see on their dashboard) ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listCache = new Map(); // short cache so the admin page is quick and we do not hammer Flutterwave

function normaliseTx(t) {
  const c = t.customer || {};
  return {
    id: t.id,
    txRef: t.tx_ref || '',
    flwRef: t.flw_ref || '',
    amount: Number(t.amount) || 0,
    charged: Number(t.charged_amount ?? t.amount) || 0,
    fee: Number(t.app_fee) || 0,
    currency: t.currency || 'NGN',
    status: String(t.status || '').toLowerCase(),
    paymentType: String(t.payment_type || '').toLowerCase(),
    createdAt: t.created_at,
    customerName: c.name || t.customer_name || '',
    customerEmail: c.email || t.customer_email || '',
    customerPhone: c.phone_number || '',
    narration: t.narration || '',
    processorResponse: t.processor_response || ''
  };
}

async function listPage(params, attempt = 0) {
  try {
    const { data } = await client().get('/transactions', { params });
    return data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 && attempt < 3) { await sleep(1200 * (attempt + 1)); return listPage(params, attempt + 1); }
    logError('list transactions', err);
    if (status === 401 || status === 403) throw new Error('Flutterwave rejected the secret key. Check FLW_SECRET_KEY on the server.');
    throw new Error('Could not read the transactions from Flutterwave right now. Please try again in a moment.');
  }
}

// Every transaction in the date range (all pages), with Flutterwave doing the status/email filtering.
// filters: { from, to, status, email }  (dates as YYYY-MM-DD)
async function fetchAllTransactions(filters, { fresh = false, maxPages = 200 } = {}) {
  const key = JSON.stringify(filters);
  const hit = listCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 90 * 1000) return hit.data;

  const base = { from: filters.from, to: filters.to, currency: 'NGN' };
  if (filters.status) base.status = filters.status;
  if (filters.email) base.customer_email = filters.email;

  const first = await listPage({ ...base, page: 1 });
  const info = (first && first.meta && first.meta.page_info) || {};
  const totalPages = Number(info.total_pages) || 1;
  const rows = (first.data || []).map(normaliseTx);

  const last = Math.min(totalPages, maxPages);
  for (let start = 2; start <= last; start += 5) {
    const batch = [];
    for (let p = start; p < start + 5 && p <= last; p++) batch.push(listPage({ ...base, page: p }));
    (await Promise.all(batch)).forEach((r) => (r.data || []).forEach((t) => rows.push(normaliseTx(t))));
  }

  const data = {
    rows,
    totalAtFlutterwave: Number(info.total) || rows.length,
    truncated: totalPages > maxPages,
    fieldsSeen: Object.keys((first.data && first.data[0]) || {}),
    fetchedAt: new Date().toISOString()
  };
  listCache.set(key, { at: Date.now(), data });
  if (listCache.size > 40) listCache.delete(listCache.keys().next().value);
  return data;
}

// Your Flutterwave balance (Naira)
async function getNgnBalance() {
  try {
    const { data } = await client().get('/balances/NGN');
    const d = Array.isArray(data?.data) ? data.data[0] : data?.data;
    if (!d) return null;
    return { available: Number(d.available_balance), ledger: Number(d.ledger_balance) };
  } catch (err) {
    logError('balance', err);
    return null;
  }
}

module.exports = { initializeFunding, verifyFunding, listBanks, resolveAccount, initiateTransfer, fetchAllTransactions, getNgnBalance };
