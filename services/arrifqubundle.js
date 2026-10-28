// Arrifqubundle integration: airtime, data, electricity, cable TV, exam PINs,
// customer verification, order look-up and the provider wallet balance.
//
// PROVIDER_MODE=mock -> simulated responses, no provider account needed.
// PROVIDER_MODE=live -> real calls using ARRIFQU_API_KEY.
//
// Endpoints (Arrifqubundle documentation): header  Authorization: Token <key>
//   GET  /api/user/                        account details + plans (data, cable)
//   GET  /api/v1/base/                     public catalogue: network, cable, disco, exam (with IDs)
//   POST /api/data/        {network, mobile_number, plan, Ported_number, customer_ref}
//   POST /api/topup/       {network, amount, mobile_number, Ported_number, airtime_type}
//   POST /api/billpayment/ {disco_name, amount, meter_number, MeterType (1 prepaid, 2 postpaid)}
//   POST /api/cablesub/    {cablename, cableplan, smart_card_number}
//   POST /api/epin/        {exam_name, quantity}                 (see note)
//   GET  /api/{data|topup|billpayment|cablesub|epin}/{id}        look up one order
//   GET  /api/validateiuc?smart_card_number=..&cablename=..
//   GET  /api/validatemeter?meternumber=..&disconame=..&mtype=..
//
// Everything the app shows (networks, plans, discos, cable packages, exam PINs
// and their IDs and prices) comes from the provider's own catalogue. There are
// no hard-coded ID tables: if an ID can't be found the service refuses to run
// instead of guessing.
//
// Not yet confirmed against a real order: the exam-PIN purchase call (/api/epin/,
// documented by ASBData, same software family) and the exact wording of order
// statuses. Exam PINs therefore start switched OFF in the admin panel.

const axios = require('axios');
const { generateRef, round2 } = require('../utils/helpers');

const isLive = () => process.env.PROVIDER_MODE === 'live';
const baseURL = () => (process.env.ARRIFQU_BASE_URL || 'https://www.arrifqubundle.com/api').replace(/\/+$/, '');

const client = () =>
  axios.create({
    baseURL: baseURL(),
    timeout: 45000,
    headers: { Authorization: `Token ${process.env.ARRIFQU_API_KEY}`, 'Content-Type': 'application/json' }
  });

const METER_TYPE = { prepaid: 1, postpaid: 2 }; // "meter type id (PREPAID:1, POSTPAID:2)" per the provider docs
const PATH = { airtime: 'topup', data: 'data', electricity: 'billpayment', cable: 'cablesub', exam: 'epin' };

// ---- Small helpers ----
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const errorText = (data) => {
  try {
    return typeof data === 'string' ? data : JSON.stringify(data);
  } catch (e) {
    return '';
  }
};

function envMap(name) {
  try {
    return JSON.parse(process.env[name] || '{}');
  } catch (e) {
    console.error(`${name} is not valid JSON, ignoring it.`);
    return {};
  }
}

// ---- Mock catalogue (PROVIDER_MODE=mock) ----
const MOCK = {
  discos: [
    { id: '1', name: 'Ikeja Electric' },
    { id: '2', name: 'Eko Electric' },
    { id: '3', name: 'Abuja Electric' },
    { id: '6', name: 'Port Harcourt Electric' }
  ],
  data: {
    mtn: [
      { variation_code: '101', name: '500MB - 2days', amount: 250, category: 'SME', validity: '2days', size: '500MB' },
      { variation_code: '102', name: '1GB - 7days', amount: 500, category: 'SME', validity: '7days', size: '1GB' },
      { variation_code: '103', name: '2GB - 30days', amount: 1400, category: 'GIFTING', validity: '30days', size: '2GB' },
      { variation_code: '104', name: '5GB - 30days', amount: 3500, category: 'GIFTING', validity: '30days', size: '5GB' },
      { variation_code: '105', name: '1GB - 1Month', amount: 700, category: 'CORPORATE GIFTING', validity: '1Month', size: '1GB' },
      { variation_code: '106', name: '75MB - 1day', amount: 75, category: 'SME2', validity: '1day', size: '75MB' }
    ],
    airtel: [
      { variation_code: '201', name: '150MB - 1day', amount: 70, category: 'AWOOF', validity: '1day', size: '150MB' },
      { variation_code: '202', name: '3GB - 7days', amount: 1000, category: 'AWOOF', validity: '7days', size: '3GB' },
      { variation_code: '203', name: '10GB - 30days', amount: 3000, category: 'CORPORATE GIFTING', validity: '30days', size: '10GB' }
    ],
    glo: [
      { variation_code: '301', name: '1.6GB - 30days', amount: 450, category: 'CORPORATE GIFTING', validity: '30days', size: '1.6GB' },
      { variation_code: '302', name: '750MB - 1day', amount: 200, category: 'AWOOF', validity: '1day', size: '750MB' }
    ],
    '9mobile': [
      { variation_code: '401', name: '500MB - 30days', amount: 250, category: 'CORPORATE GIFTING', validity: '30days', size: '500MB' },
      { variation_code: '402', name: '1GB - 30days', amount: 500, category: 'CORPORATE GIFTING', validity: '30days', size: '1GB' }
    ]
  },
  cable: {
    dstv: [
      { variation_code: '501', name: 'DStv Padi', amount: 4400 },
      { variation_code: '502', name: 'DStv Yanga', amount: 6000 },
      { variation_code: '503', name: 'DStv Compact', amount: 19000 }
    ],
    gotv: [
      { variation_code: '511', name: 'GOtv Smallie - Monthly', amount: 1900 },
      { variation_code: '512', name: 'GOtv Jinja-Monthly', amount: 3900 }
    ],
    startimes: [
      { variation_code: '521', name: 'Nova - 700 Naira - 1 Week', amount: 700 },
      { variation_code: '522', name: 'Smart - 1,400 Naira - 1 Week', amount: 1400 }
    ]
  },
  exam: [
    { serviceID: 'WAEC', variation_code: 'WAEC', name: 'WAEC Result Checker PIN', amount: 5150 },
    { serviceID: 'NECO', variation_code: 'NECO', name: 'NECO Result Checker PIN', amount: 2250 }
  ]
};

// ---- Cached reads from the provider ----
const cache = {};
async function cached(key, loader, ttlMs = 5 * 60 * 1000, force = false) {
  const hit = cache[key];
  if (!force && hit && Date.now() - hit.at < ttlMs) return hit.data;
  const data = await loader();
  cache[key] = { at: Date.now(), data };
  return data;
}

// /api/user/: account details + Dataplans + Cableplan
const getUser = (force = false) => cached('user', async () => (await client().get('/user/')).data, 5 * 60 * 1000, force);

// /api/v1/base/: public catalogue of networks, cable, discos and exam PINs
async function getBase(force = false) {
  try {
    return await cached('base', async () => {
      const { data } = await axios.get(`${baseURL()}/v1/base/`, { timeout: 20000 });
      if (!data || typeof data !== 'object') throw new Error('not json');
      return data;
    }, 10 * 60 * 1000, force);
  } catch (e) {
    return null;
  }
}

const userType = (user) => user?.user?.user_type || user?.user_type || null;

// ---- IDs (from the catalogue only) ----
const NETWORK_KEY = { mtn: 'MTN', glo: 'GLO', airtel: 'AIRTEL', '9mobile': '9MOBILE' };
const CABLE_KEY = { dstv: 'DSTV', gotv: 'GOTV', startimes: 'STARTIME' };

async function networkEntry(network) {
  const key = NETWORK_KEY[String(network).toLowerCase()];
  if (!key) return null;
  const override = envMap('ARRIFQU_NETWORK_IDS')[String(network).toLowerCase()];
  const base = await getBase();
  const hit = (base?.network || []).find((n) => norm(n.name) === norm(key));
  if (override !== undefined) return { id: override, entry: hit || null };
  if (hit && hit.id !== undefined) return { id: hit.id, entry: hit };
  // fall back to the network id carried by that network's own plans
  const user = await getUser().catch(() => null);
  const plans = user?.Dataplans?.[`${key}_PLAN`];
  const sample = plans && (plans.ALL?.[0] || Object.values(plans).flat()[0]);
  if (sample && sample.network !== undefined) return { id: sample.network, entry: null };
  return null;
}

async function cableEntry(provider) {
  const key = CABLE_KEY[String(provider).toLowerCase()];
  if (!key) return null;
  const override = envMap('ARRIFQU_CABLE_IDS')[String(provider).toLowerCase()];
  const base = await getBase();
  const hit = (base?.cable || []).find((c) => norm(c.name) === norm(key));
  if (override !== undefined) return { id: override, entry: hit || null };
  if (hit && hit.id !== undefined) return { id: hit.id, entry: hit };
  const user = await getUser().catch(() => null);
  const fromUser = (user?.Cableplan?.cablename || []).find((c) => norm(c.name) === norm(key));
  return fromUser ? { id: fromUser.id, entry: null } : null;
}

async function getDiscos() {
  if (!isLive()) return MOCK.discos;
  const base = await getBase();
  return (base?.disco || []).filter((d) => d && d.id !== undefined).map((d) => ({ id: String(d.id), name: String(d.name) }));
}

// ---- Catalogue: data plans, cable packages, exam PINs ----
const tidySize = (s) => String(s ?? '').replace(/\.0+(?=[A-Za-z])/g, '').trim();

async function getVariations(kind, providerName) {
  if (!isLive()) {
    if (kind === 'exam') return MOCK.exam;
    return MOCK[kind]?.[providerName] || [];
  }

  try {
    if (kind === 'exam') {
      const base = await getBase();
      return (base?.exam || [])
        .filter((e) => e && e.exam_name && num(e.amount) > 0)
        .map((e) => ({ serviceID: String(e.exam_name), variation_code: String(e.exam_name), name: `${e.exam_name} Result Checker PIN`, amount: num(e.amount) }));
    }

    if (kind === 'data') {
      const key = NETWORK_KEY[String(providerName).toLowerCase()];
      if (!key) return [];
      const user = await getUser();
      const group = user?.Dataplans?.[`${key}_PLAN`];
      if (!group) return [];
      const type = userType(user);
      // "ALL" repeats every plan that is also listed in its own category: read one list, then de-duplicate by id.
      const list = Array.isArray(group.ALL) ? group.ALL : Object.values(group).flat();
      const seen = new Set();
      const plans = [];
      for (const p of list) {
        if (!p || p.id === undefined || seen.has(p.id)) continue;
        seen.add(p.id);
        const validity = String(p.month_validate ?? '').trim();
        if (/not\s*available/i.test(validity)) continue; // the provider itself marks these as unavailable
        const price = num((type && p[`${type}_price`]) ?? p.plan_amount);
        if (!Number.isFinite(price) || price <= 0) continue;
        const size = tidySize(p.plan);
        plans.push({
          variation_code: String(p.id),
          name: [size, validity].filter(Boolean).join(' - '),
          amount: round2(price),
          category: String(p.plan_type || 'OTHER').toUpperCase(),
          validity,
          size
        });
      }
      return plans.sort((a, b) => a.amount - b.amount);
    }

    if (kind === 'cable') {
      const c = await cableEntry(providerName);
      if (!c) return [];
      let list = c.entry?.cableplan;
      if (!Array.isArray(list)) {
        const user = await getUser();
        list = user?.Cableplan?.[`${CABLE_KEY[String(providerName).toLowerCase()]}PLAN`] || [];
      }
      return list
        .filter((p) => p && p.id !== undefined && num(p.plan_amount) > 0)
        .map((p) => ({ variation_code: String(p.id), name: String(p.package).trim(), amount: round2(num(p.plan_amount)) }))
        .sort((a, b) => a.amount - b.amount);
    }
  } catch (err) {
    console.error('Arrifqubundle catalog error:', err.response?.status, errorText(err.response?.data) || err.message);
  }
  return [];
}

// ---- Customer verification (meter number / smartcard) ----
const readName = (d) => d?.name || d?.Customer_Name || d?.customer_name || d?.customerName || d?.account_name || '';

async function tryValidate(path, params) {
  try {
    const { data } = await client().get(path, { params });
    if (!data || typeof data !== 'object') return null;
    const name = readName(data);
    if (data.invalid === true || data.error || (!name && data.invalid !== false)) return null;
    return { ok: true, customerName: name, details: data };
  } catch (e) {
    return null;
  }
}

// The documentation shows IDs (disconame=1, cablename=2); a sister provider documents
// names instead. Both are read-only lookups, so try IDs first and names second.
async function verifyCustomer({ kind, discoId, discoName, meterType, meter, provider, smartcardNumber }) {
  if (!isLive()) {
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, customerName: 'MOCK CUSTOMER', details: {}, style: 'mock' };
  }

  const fail = { ok: false, message: 'We could not verify those details. Please check the number and try again.' };
  try {
    if (kind === 'electricity') {
      if (discoId === undefined || discoId === null || discoId === '') return { ok: false, message: 'Choose a distribution company.' };
      const byId = await tryValidate('/validatemeter', { meternumber: meter, disconame: discoId, mtype: METER_TYPE[meterType] || 1 });
      if (byId) return { ...byId, style: 'id' };
      if (discoName) {
        const byName = await tryValidate('/validatemeter', { meternumber: meter, disconame: discoName, mtype: meterType === 'postpaid' ? 'Postpaid' : 'Prepaid' });
        if (byName) return { ...byName, style: 'name' };
      }
      return fail;
    }
    if (kind === 'cable') {
      const c = await cableEntry(provider);
      if (!c) return { ok: false, message: 'That cable provider is not available right now.' };
      const byId = await tryValidate('/validateiuc', { smart_card_number: smartcardNumber, cablename: c.id });
      if (byId) return { ...byId, style: 'id' };
      const byName = await tryValidate('/validateiuc', { smart_card_number: smartcardNumber, cablename: c.entry?.name || CABLE_KEY[provider] });
      if (byName) return { ...byName, style: 'name' };
      return fail;
    }
    return { ok: false, message: 'Verification is not available for this service.' };
  } catch (err) {
    console.error('Arrifqubundle verify error:', err.message);
    return { ok: false, message: 'Verification is unavailable right now. Please try again.' };
  }
}

// ---- Interpreting responses ----
// Only an explicit "successful" counts as success. An explicit failure is a
// failure. Anything else (processing, unknown) is pending, and the wallet is
// NOT refunded until the provider confirms failure.
function interpret(data) {
  // Plain-text "Forbidden." means the account's allowed-IP rule refused this server. Nothing was bought.
  if (typeof data === 'string') {
    if (/forbidden/i.test(data)) {
      console.error('Provider replied "Forbidden": add this server\'s outbound IPs to the allowed IP list in your provider account (or remove the IP lock).');
      return { state: 'failed', code: 'FORBIDDEN', message: 'This service is temporarily unavailable. Please try again shortly.', providerId: null, token: null, cards: null, raw: data };
    }
    return { state: 'pending', message: 'Your order is being processed.', providerId: null, token: null, cards: null, raw: data };
  }

  const status = String(data?.Status ?? data?.status ?? '').toLowerCase();
  const token = data?.token || data?.Token || data?.meter_token || data?.pins || data?.purchased_code || null;
  const cost = num(data?.paid_amount ?? data?.plan_amount ?? data?.amount);
  const extra = {
    providerId: data?.id !== undefined && data?.id !== null ? String(data.id) : null,
    providerRef: data?.ident || (data?.id !== undefined ? String(data.id) : null),
    providerCost: Number.isFinite(cost) ? cost : null,
    token: token ? String(token) : null,
    cards: null,
    raw: data
  };

  if (['successful', 'success', 'completed', 'delivered'].includes(status)) {
    return { state: 'success', message: 'Transaction successful', ...extra };
  }
  if (['failed', 'fail', 'error', 'cancelled', 'canceled', 'refunded', 'reversed'].includes(status)) {
    return { state: 'failed', message: 'Transaction failed. You have not been charged.', ...extra };
  }
  return { state: 'pending', message: 'Your order is being processed.', ...extra };
}

// ---- Purchase ----
// `payload` shape depends on `kind`; see routes/services.js.
async function purchase(kind, payload) {
  const request_id = generateRef('ARQ');

  if (!isLive()) {
    await new Promise((r) => setTimeout(r, 600));
    if (payload.phone === '00000000000' || payload.meter === '0000000000') {
      return { ok: false, state: 'failed', request_id, message: 'Transaction failed at the provider. No charge was made.' };
    }
    if (payload.phone === '11111111111') {
      return { ok: false, state: 'pending', request_id, message: 'Your order is being processed.' };
    }
    return {
      ok: true,
      state: 'success',
      request_id,
      message: 'Transaction successful',
      providerRef: `MOCK-${request_id}`,
      providerId: null,
      token: kind === 'electricity' ? 'Token : 1234-5678-9012-3456-7890' : kind === 'exam' ? 'PIN : 1234567890' : null
    };
  }

  if (!process.env.ARRIFQU_API_KEY) {
    console.error('ARRIFQU_API_KEY is not set.');
    return { ok: false, state: 'failed', request_id, message: 'This service is temporarily unavailable. Please try again shortly.', logMessage: 'ARRIFQU_API_KEY is not set' };
  }

  let body;
  try {
    switch (kind) {
      case 'airtime': {
        const n = await networkEntry(payload.network);
        if (!n) throw new Error('network id not found');
        const types = (n.entry?.airtime_type || []).map((t) => t.value || t.name).filter(Boolean);
        const airtimeType = types.find((t) => String(t).toUpperCase() === 'VTU') || types[0];
        if (!airtimeType) throw new Error('no airtime type offered for this network');
        body = { network: n.id, amount: payload.amount, mobile_number: payload.phone, Ported_number: true, airtime_type: airtimeType };
        break;
      }
      case 'data': {
        const n = await networkEntry(payload.network);
        if (!n) throw new Error('network id not found');
        body = { network: n.id, mobile_number: payload.phone, plan: Number(payload.variation_code) || payload.variation_code, Ported_number: true, customer_ref: request_id };
        break;
      }
      case 'electricity':
        if (payload.discoId === undefined || payload.discoId === null || payload.discoId === '') throw new Error('disco id missing');
        body = { disco_name: Number(payload.discoId) || payload.discoId, amount: payload.amount, meter_number: payload.meter, MeterType: METER_TYPE[payload.variation_code] || 1, Customer_Phone: payload.phone };
        break;
      case 'cable': {
        const c = await cableEntry(payload.provider);
        if (!c) throw new Error('cable id not found');
        body = { cablename: c.id, cableplan: Number(payload.variation_code) || payload.variation_code, smart_card_number: payload.smartcardNumber };
        break;
      }
      case 'exam':
        body = { exam_name: payload.variation_code, quantity: payload.quantity || 1 };
        break;
      default:
        return { ok: false, state: 'failed', request_id, message: 'This service is not available right now.' };
    }
  } catch (err) {
    console.error(`Arrifqubundle: cannot build ${kind} order:`, err.message);
    return { ok: false, state: 'failed', request_id, message: 'This service is temporarily unavailable. Please try again shortly.', logMessage: err.message };
  }

  try {
    const { data } = await client().post(`/${PATH[kind]}/`, body);
    const r = interpret(data);
    return { ok: r.state === 'success', request_id, ...r };
  } catch (err) {
    const status = err.response?.status;
    if (status && status >= 400 && status < 500) {
      // The provider refused the request outright, so nothing was bought.
      const text = errorText(err.response.data);
      console.error('Arrifqubundle declined:', status, text);
      const lowFunds = /insufficient|low balance|balance/i.test(text);
      const tooFast = /too many requests|slow down/i.test(text);
      if (lowFunds) console.error('ARRIFQUBUNDLE WALLET MAY BE OUT OF FUNDS. Top it up.');
      if (tooFast) console.error('Provider rate limit hit. Ask the provider to set your account type to API (no purchase limit).');
      return {
        ok: false,
        state: 'failed',
        request_id,
        message: tooFast
          ? 'Too many orders at once. Please wait a minute and try again. You have not been charged.'
          : lowFunds
            ? 'This service is temporarily unavailable. Please try again shortly.'
            : 'Transaction failed. You have not been charged.',
        logMessage: `HTTP ${status}: ${text.slice(0, 300)}`,
        raw: err.response.data
      };
    }
    // Timeout / network drop / 5xx: the order MAY have gone through. Don't refund yet.
    console.error('Arrifqubundle purchase: unclear outcome, marking pending:', status || err.message);
    return { ok: false, state: 'pending', request_id, message: 'Your order is being processed.', logMessage: `No clear answer (${status || err.message})` };
  }
}

// ---- Look up an order by the provider's own id ----
async function requery(kind, providerId) {
  if (!isLive()) return { state: 'success', message: 'Transaction successful' };
  if (!PATH[kind] || !providerId) return { state: 'pending', message: 'Still processing.' };
  try {
    const { data } = await client().get(`/${PATH[kind]}/${providerId}`);
    return interpret(data);
  } catch (err) {
    console.error('Arrifqubundle requery error:', err.response?.status, errorText(err.response?.data) || err.message);
    return { state: 'pending', message: 'Still processing.' };
  }
}

// ---- Recover a data order whose request timed out, using our customer_ref ----
async function findByRef(kind, ref) {
  if (!isLive() || kind !== 'data') return { state: 'pending' };
  try {
    const { data } = await client().get('/data/', { params: { search: ref } });
    const list = Array.isArray(data) ? data : data?.results || [];
    const hit = list.find((o) => o && o.customer_ref === ref);
    if (!hit) return { state: 'pending' };
    return interpret(hit);
  } catch (err) {
    return { state: 'pending' };
  }
}

// ---- Provider wallet balance (shown in the admin dashboard) ----
async function getBalance() {
  if (!isLive()) return { ok: true, balance: 250000, mock: true };
  try {
    const data = await getUser(true);
    const balance = num(data?.user?.Account_Balance);
    if (!Number.isFinite(balance)) {
      return { ok: false, message: 'Connected, but the balance (Account_Balance) was not in the provider response.' };
    }
    return { ok: true, balance: round2(balance) };
  } catch (err) {
    console.error('Arrifqubundle balance error:', err.response?.status, errorText(err.response?.data) || err.message);
    const status = err.response?.status;
    return {
      ok: false,
      message: status === 401 || status === 403 ? 'The provider rejected the API key. Check ARRIFQU_API_KEY.' : 'Could not reach the provider.'
    };
  }
}

// ---- Diagnostics for the admin "Provider check" button ----
function summarise(node, depth = 0) {
  if (Array.isArray(node)) return { _type: 'list', count: node.length, sample: node.slice(0, 2).map((n) => summarise(n, depth + 1)) };
  if (node && typeof node === 'object') {
    if (depth > 4) return '{...}';
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, /token|password|secret|key|pin|email|phone|address|bank|account|referer|username|fullname/i.test(k) ? '[hidden]' : summarise(v, depth + 1)])
    );
  }
  return node;
}

async function diagnostics() {
  if (!isLive()) return { mode: 'mock', note: 'Set PROVIDER_MODE=live and ARRIFQU_API_KEY to inspect the real provider response.' };
  try {
    const user = await getUser(true);
    const base = await getBase(true);
    const warnings = [];
    if (!base) warnings.push('Public catalogue /v1/base/ is not available: electricity companies and exam PINs cannot be offered.');
    const type = userType(user);
    if (type && String(type).toUpperCase() !== 'API') {
      warnings.push(`Account type is "${type}". Some providers allow only 1 purchase per minute unless the account type is API. Ask support if customers hit "Too many requests".`);
    }
    const ids = {};
    for (const n of Object.keys(NETWORK_KEY)) ids[n] = (await networkEntry(n))?.id ?? null;
    const cableIds = {};
    for (const c of Object.keys(CABLE_KEY)) cableIds[c] = (await cableEntry(c))?.id ?? null;
    return {
      mode: 'live',
      baseURL: baseURL(),
      accountType: type,
      warnings,
      networkIds: ids,
      cableIds,
      discos: await getDiscos(),
      examPins: (base?.exam || []).map((e) => `${e.exam_name}: ${e.amount}`),
      sampleDataPlans: (await getVariations('data', 'mtn')).slice(0, 3),
      sampleCablePlans: (await getVariations('cable', 'dstv')).slice(0, 3),
      detectedBalance: num(user?.user?.Account_Balance),
      userResponse: summarise(user),
      catalogueResponse: summarise(base)
    };
  } catch (err) {
    return { mode: 'live', error: err.response?.status || err.message, body: summarise(err.response?.data) };
  }
}

module.exports = { getVariations, getDiscos, verifyCustomer, purchase, requery, findByRef, getBalance, diagnostics, MOCK };
