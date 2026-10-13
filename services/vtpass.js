// VTpass integration: airtime, data, electricity, cable TV, exam PINs,
// customer verification, transaction re-query and the VTpass wallet balance.
//
// PROVIDER_MODE=mock  -> simulated responses, no VTpass account needed.
// PROVIDER_MODE=live  -> real VTpass calls using the keys in .env.
//
// VTpass docs: https://www.vtpass.com/documentation/
//   Sandbox: https://sandbox.vtpass.com/api      Live: https://vtpass.com/api
//   GET calls authenticate with  api-key + public-key
//   POST calls authenticate with api-key + secret-key

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const isLive = () => process.env.PROVIDER_MODE === 'live';
const baseURL = () => (process.env.VTPASS_BASE_URL || 'https://sandbox.vtpass.com/api').replace(/\/+$/, '');

const getClient = () =>
  axios.create({
    baseURL: baseURL(),
    timeout: 30000,
    headers: { 'api-key': process.env.VTPASS_API_KEY, 'public-key': process.env.VTPASS_PUBLIC_KEY }
  });

const postClient = () =>
  axios.create({
    baseURL: baseURL(),
    timeout: 60000,
    headers: {
      'api-key': process.env.VTPASS_API_KEY,
      'secret-key': process.env.VTPASS_SECRET_KEY,
      'Content-Type': 'application/json'
    }
  });

// VTpass requires request_id to START with the current date/time in the
// Africa/Lagos timezone as YYYYMMDDHHmm, followed by any alphanumerics.
function requestId() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${uuidv4().replace(/-/g, '').slice(0, 12)}`;
}

// ---- Service ID maps (VTpass naming) ----
const NETWORK = { mtn: 'mtn', airtel: 'airtel', glo: 'glo', '9mobile': 'etisalat', etisalat: 'etisalat' };
const dataServiceId = (network) => `${NETWORK[String(network).toLowerCase()]}-data`;
const EXAM_SERVICES = ['waec', 'waec-registration', 'jamb'];

// ---- Mock catalog (used in PROVIDER_MODE=mock) ----
const MOCK_CATALOG = {
  data: {
    mtn: [
      { variation_code: 'mtn-100mb-1day', name: '100MB - 1 Day', amount: 100 },
      { variation_code: 'mtn-1gb-1day', name: '1GB - 1 Day', amount: 350 },
      { variation_code: 'mtn-2gb-30day', name: '2GB - 30 Days', amount: 1400 },
      { variation_code: 'mtn-5gb-30day', name: '5GB - 30 Days', amount: 3500 }
    ],
    airtel: [
      { variation_code: 'airtel-1gb-1day', name: '1GB - 1 Day', amount: 300 },
      { variation_code: 'airtel-3gb-7day', name: '3GB - 7 Days', amount: 1000 },
      { variation_code: 'airtel-10gb-30day', name: '10GB - 30 Days', amount: 3000 }
    ],
    glo: [
      { variation_code: 'glo-1.5gb-30day', name: '1.5GB - 30 Days', amount: 1000 },
      { variation_code: 'glo-5.8gb-30day', name: '5.8GB - 30 Days', amount: 2000 }
    ],
    '9mobile': [
      { variation_code: '9mobile-1.5gb-30day', name: '1.5GB - 30 Days', amount: 1200 },
      { variation_code: '9mobile-4.5gb-30day', name: '4.5GB - 30 Days', amount: 2500 }
    ]
  },
  cable: {
    dstv: [
      { variation_code: 'dstv-padi', name: 'DStv Padi', amount: 4400 },
      { variation_code: 'dstv-yanga', name: 'DStv Yanga', amount: 6000 },
      { variation_code: 'dstv-compact', name: 'DStv Compact', amount: 19000 }
    ],
    gotv: [
      { variation_code: 'gotv-smallie', name: 'GOtv Smallie', amount: 1900 },
      { variation_code: 'gotv-jinja', name: 'GOtv Jinja', amount: 3900 },
      { variation_code: 'gotv-max', name: 'GOtv Max', amount: 8500 }
    ],
    startimes: [
      { variation_code: 'nova', name: 'Nova', amount: 1900 },
      { variation_code: 'basic', name: 'Basic', amount: 4200 }
    ]
  },
  exam: [
    { serviceID: 'waec-registration', variation_code: 'waec-registraion', name: 'WAEC Registration PIN', amount: 27300 },
    { serviceID: 'waec', variation_code: 'waecdirect', name: 'WAEC Result Checker PIN', amount: 3400 },
    { serviceID: 'jamb', variation_code: 'utme-mock', name: 'JAMB UTME PIN (with mock)', amount: 7700, needsProfile: true },
    { serviceID: 'jamb', variation_code: 'utme-no-mock', name: 'JAMB UTME PIN (no mock)', amount: 6200, needsProfile: true }
  ]
};

// ---- Interpreting VTpass responses ----
// Returns { state: 'success' | 'pending' | 'failed', message, ... }
// Never guess success: only "delivered" counts. Anything unclear is "pending"
// so the wallet is NOT refunded until we've confirmed via re-query/webhook.
function interpret(data) {
  const code = String(data?.code ?? '');
  const txn = data?.content?.transactions || {};
  const status = String(txn.status || '').toLowerCase();

  const token = data?.token || data?.purchased_code || null;
  const extra = {
    providerRef: txn.transactionId || data?.requestId || null,
    token: token ? String(token) : null,
    cards: Array.isArray(data?.cards) ? data.cards : null,
    raw: data
  };

  if (code === '000') {
    if (status === 'delivered') {
      return { state: 'success', message: data?.response_description || 'Transaction successful', ...extra };
    }
    if (status === 'failed' || status === 'reversed') {
      return { state: 'failed', message: 'Transaction failed. You have not been charged.', ...extra };
    }
    return { state: 'pending', message: 'Your order is being processed.', ...extra }; // pending / initiated / unknown
  }
  if (code === '099' || code === '091') {
    return { state: 'pending', message: 'Your order is being processed.', ...extra };
  }
  if (code === '018') {
    // VTpass wallet is out of funds. Customers must not see this; the admin must top up.
    console.error('VTPASS LOW WALLET BALANCE. Top up your VTpass wallet.');
    return { state: 'failed', message: 'This service is temporarily unavailable. Please try again shortly.', ...extra };
  }
  console.error('VTpass declined:', code, data?.response_description);
  return { state: 'failed', message: 'Transaction failed. You have not been charged.', ...extra };
}

// ---- Catalog ----
function normalisePlans(list, serviceID) {
  return (list || []).map((v) => ({
    variation_code: v.variation_code,
    name: v.name,
    amount: Number(v.variation_amount),
    ...(serviceID ? { serviceID, needsProfile: serviceID === 'jamb' } : {})
  }));
}

async function fetchVariations(serviceID) {
  const { data } = await getClient().get('/service-variations', { params: { serviceID } });
  // VTpass has historically misspelt the key as "varations".
  return data?.content?.variations || data?.content?.varations || [];
}

async function getVariations(kind, provider) {
  if (!isLive()) {
    if (kind === 'exam') return MOCK_CATALOG.exam;
    return MOCK_CATALOG[kind]?.[provider] || [];
  }

  try {
    if (kind === 'data') return normalisePlans(await fetchVariations(dataServiceId(provider)));
    if (kind === 'cable') return normalisePlans(await fetchVariations(provider));
    if (kind === 'exam') {
      const results = await Promise.allSettled(EXAM_SERVICES.map((s) => fetchVariations(s)));
      return results.flatMap((r, i) => (r.status === 'fulfilled' ? normalisePlans(r.value, EXAM_SERVICES[i]) : []));
    }
  } catch (err) {
    console.error('VTpass catalog error:', err.response?.status, err.response?.data || err.message);
  }
  return [];
}

// ---- Customer verification (meter number, smartcard, JAMB profile) ----
async function verifyCustomer({ serviceID, billersCode, type }) {
  if (!isLive()) {
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, customerName: 'MOCK CUSTOMER', details: { Address: 'Mock address' } };
  }
  try {
    const { data } = await postClient().post('/merchant-verify', { serviceID, billersCode, type });
    const c = data?.content || {};
    if (data?.code === '000' && !c.error && (c.Customer_Name || c.Customer_Name === '')) {
      return { ok: true, customerName: c.Customer_Name, details: c };
    }
    return { ok: false, message: c.error || 'We could not verify those details. Please check and try again.' };
  } catch (err) {
    console.error('VTpass verify error:', err.response?.status, err.response?.data || err.message);
    return { ok: false, message: 'Verification is unavailable right now. Please try again.' };
  }
}

// ---- Purchase ----
// `payload` shape depends on `kind`; see routes/services.js.
async function purchase(kind, payload) {
  const request_id = isLive() ? requestId() : `MOCK${Date.now()}${uuidv4().slice(0, 6)}`;

  if (!isLive()) {
    await new Promise((r) => setTimeout(r, 600));
    // Test hooks: these numbers simulate a failure / a slow (pending) order.
    if (payload.phone === '00000000000' || payload.meter === '0000000000') {
      return { ok: false, state: 'failed', request_id, message: 'Transaction failed at the provider. No charge was made.' };
    }
    if (payload.phone === '11111111111') {
      return { ok: false, state: 'pending', request_id, message: 'Your order is being processed.' };
    }
    const token =
      kind === 'electricity' ? 'Token : 1234-5678-9012-3456-7890' : kind === 'exam' ? 'Pin : 1234567890' : null;
    return {
      ok: true,
      state: 'success',
      request_id,
      message: 'Transaction successful',
      providerRef: `MOCK-${request_id}`,
      token,
      customerName: payload.customerName || null
    };
  }

  const body = { request_id, phone: payload.phone };
  switch (kind) {
    case 'airtime':
      Object.assign(body, { serviceID: NETWORK[String(payload.network).toLowerCase()], amount: payload.amount });
      break;
    case 'data':
      Object.assign(body, {
        serviceID: dataServiceId(payload.network),
        billersCode: payload.phone,
        variation_code: payload.variation_code
      });
      break;
    case 'electricity':
      Object.assign(body, {
        serviceID: payload.disco,
        billersCode: payload.meter,
        variation_code: payload.variation_code, // "prepaid" | "postpaid"
        amount: payload.amount
      });
      break;
    case 'cable':
      Object.assign(body, {
        serviceID: payload.provider,
        billersCode: payload.smartcardNumber,
        variation_code: payload.variation_code,
        amount: payload.planAmount,
        quantity: 1
      });
      if (payload.provider === 'dstv' || payload.provider === 'gotv') body.subscription_type = 'change';
      break;
    case 'exam':
      Object.assign(body, {
        serviceID: payload.examBody,
        variation_code: payload.variation_code,
        quantity: payload.quantity || 1,
        amount: payload.planAmount
      });
      if (payload.billersCode) body.billersCode = payload.billersCode; // JAMB profile ID
      break;
    default:
      return { ok: false, state: 'failed', request_id, message: 'Unsupported service.' };
  }

  try {
    const { data } = await postClient().post('/pay', body);
    const r = interpret(data);
    return { ok: r.state === 'success', request_id, ...r };
  } catch (err) {
    if (err.response) {
      // VTpass answered with an error body: treat it as a definite answer.
      const r = interpret(err.response.data);
      return { ok: r.state === 'success', request_id, ...r, state: r.state === 'pending' ? 'pending' : 'failed' };
    }
    // No response at all (timeout / network drop): the order MAY have gone through.
    // Don't refund yet. The re-query/webhook will settle it.
    console.error('VTpass pay: no response, marking pending:', err.message);
    return { ok: false, state: 'pending', request_id, message: 'Your order is being processed.' };
  }
}

// ---- Re-query a transaction by the request_id we sent ----
async function requery(request_id) {
  if (!isLive()) return { state: 'success', message: 'Transaction successful' };
  try {
    const { data } = await postClient().post('/requery', { request_id });
    return interpret(data);
  } catch (err) {
    console.error('VTpass requery error:', err.response?.status, err.response?.data || err.message);
    return { state: 'pending', message: 'Still processing.' };
  }
}

// ---- VTpass wallet balance (shown in the admin dashboard) ----
async function getBalance() {
  if (!isLive()) return { ok: true, balance: 250000, mock: true };
  try {
    const { data } = await getClient().get('/balance');
    const balance = Number(data?.contents?.balance);
    if (Number.isNaN(balance)) return { ok: false, message: 'VTpass returned an unexpected balance response.' };
    return { ok: true, balance };
  } catch (err) {
    console.error('VTpass balance error:', err.response?.status, err.response?.data || err.message);
    const status = err.response?.status;
    return {
      ok: false,
      message:
        status === 401 || status === 403
          ? 'VTpass rejected the keys, or this server\'s IP is not whitelisted on VTpass.'
          : 'Could not reach VTpass.'
    };
  }
}

module.exports = { getVariations, verifyCustomer, purchase, requery, getBalance, MOCK_CATALOG };
