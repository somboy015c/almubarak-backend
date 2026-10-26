// Arrifqubundle integration: airtime, data, electricity, cable TV, customer
// verification, transaction re-query and the provider wallet balance.
//
// PROVIDER_MODE=mock -> simulated responses, no provider account needed.
// PROVIDER_MODE=live -> real calls using ARRIFQU_API_KEY.
//
// API (from Arrifqubundle's documentation): header  Authorization: Token <key>
//   GET  /api/user/                        account details (+ plan catalog)
//   POST /api/data/        {network, mobile_number, plan, Ported_number}
//   POST /api/topup/       {network, amount, mobile_number, Ported_number, airtime_type}
//   POST /api/billpayment/ {disco_name, amount, meter_number, MeterType (1 prepaid, 2 postpaid)}
//   POST /api/cablesub/    {cablename, cableplan, smart_card_number}
//   GET  /api/{data|topup|billpayment|cablesub}/{id}   look up one transaction
//   GET  /api/validateiuc?smart_card_number=..&cablename=..
//   GET  /api/validatemeter?meternumber=..&disconame=..&mtype=..
//
// Arrifqubundle's own documentation lists the endpoints above but not the ID
// lists or response layouts. ASBData (same software family) documents these
// extra calls, which this adapter tries and falls back from if they don't exist:
//   GET  /api/v1/base/   public catalogue: network, cable, disco, exam lists with IDs
//   GET  /api/network/   data plans      GET /api/cable/   cable packages
//   POST /api/epin/      {exam_name, quantity}   exam PINs
// Confirm everything with the "Provider check" button in the admin panel
// (Overview) before going live.

const axios = require('axios');
const { generateRef } = require('../utils/helpers');

const isLive = () => process.env.PROVIDER_MODE === 'live';
const baseURL = () => (process.env.ARRIFQU_BASE_URL || 'https://www.arrifqubundle.com/api').replace(/\/+$/, '');

const client = () =>
  axios.create({
    baseURL: baseURL(),
    timeout: 45000,
    headers: { Authorization: `Token ${process.env.ARRIFQU_API_KEY}`, 'Content-Type': 'application/json' }
  });

// ---- Fallback ID maps (used only when the provider's catalog doesn't list them) ----
const FALLBACK_NETWORK = { mtn: 1, glo: 2, '9mobile': 3, airtel: 4 };
const FALLBACK_CABLE = { dstv: 1, gotv: 2, startimes: 3 };
const FALLBACK_DISCO = {
  'ikeja-electric': 1, 'eko-electric': 2, 'abuja-electric': 3, 'kano-electric': 4, 'enugu-electric': 5,
  'portharcourt-electric': 6, 'ibadan-electric': 7, 'kaduna-electric': 8, 'jos-electric': 9,
  'yola-electric': 10, 'benin-electric': 11, 'aba-electric': 12
};
// Arrifqubundle's docs: MeterType PREPAID=1, POSTPAID=2. ASBData's docs use the words
// "Prepaid"/"Postpaid" instead. Set ARRIFQU_METERTYPE_STYLE=name if orders are rejected for MeterType.
const meterTypeValue = (t) => {
  const type = t === 'postpaid' ? 'postpaid' : 'prepaid';
  if (process.env.ARRIFQU_METERTYPE_STYLE === 'name') return type === 'postpaid' ? 'Postpaid' : 'Prepaid';
  return type === 'postpaid' ? 2 : 1;
};
const PATH = { airtime: 'topup', data: 'data', electricity: 'billpayment', cable: 'cablesub', exam: 'epin' };

// Optional overrides from the environment, e.g. ARRIFQU_DISCO_IDS={"ikeja-electric":1,...}
function envMap(name, fallback) {
  try {
    return { ...fallback, ...JSON.parse(process.env[name] || '{}') };
  } catch (e) {
    console.error(`${name} is not valid JSON, ignoring it.`);
    return fallback;
  }
}

// ---- Mock catalog (PROVIDER_MODE=mock) ----
const MOCK_CATALOG = {
  data: {
    mtn: [
      { variation_code: '101', name: 'MTN 500MB SME - 30 days', amount: 140 },
      { variation_code: '102', name: 'MTN 1GB SME - 30 days', amount: 270 },
      { variation_code: '103', name: 'MTN 2GB SME - 30 days', amount: 540 },
      { variation_code: '104', name: 'MTN 5GB SME - 30 days', amount: 1350 }
    ],
    airtel: [
      { variation_code: '201', name: 'Airtel 1GB - 7 days', amount: 300 },
      { variation_code: '202', name: 'Airtel 3GB - 30 days', amount: 1000 },
      { variation_code: '203', name: 'Airtel 10GB - 30 days', amount: 3000 }
    ],
    glo: [
      { variation_code: '301', name: 'Glo 1.6GB - 30 days', amount: 450 },
      { variation_code: '302', name: 'Glo 5GB - 30 days', amount: 1500 }
    ],
    '9mobile': [
      { variation_code: '401', name: '9mobile 1.5GB - 30 days', amount: 1000 },
      { variation_code: '402', name: '9mobile 4.5GB - 30 days', amount: 2000 }
    ]
  },
  cable: {
    dstv: [
      { variation_code: '501', name: 'DStv Padi', amount: 4400 },
      { variation_code: '502', name: 'DStv Yanga', amount: 6000 },
      { variation_code: '503', name: 'DStv Compact', amount: 19000 }
    ],
    gotv: [
      { variation_code: '511', name: 'GOtv Smallie', amount: 1900 },
      { variation_code: '512', name: 'GOtv Jinja', amount: 3900 },
      { variation_code: '513', name: 'GOtv Max', amount: 8500 }
    ],
    startimes: [
      { variation_code: '521', name: 'Startimes Nova', amount: 1900 },
      { variation_code: '522', name: 'Startimes Basic', amount: 4200 }
    ]
  },
  exam: [
    { serviceID: 'WAEC', variation_code: 'WAEC', name: 'WAEC Result Checker PIN', amount: 3500 },
    { serviceID: 'NECO', variation_code: 'NECO', name: 'NECO Result Checker PIN', amount: 1300 }
  ]
};

// ---- Small helpers ----
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Walk any nested object/array and collect every array of objects found.
function collectArrays(node, out = []) {
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === 'object') out.push(node);
    node.forEach((n) => collectArrays(n, out));
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach((v) => collectArrays(v, out));
  }
  return out;
}

// ---- Cached reads from the provider ----
const cache = {};
async function cached(key, loader, ttlMs = 5 * 60 * 1000, force = false) {
  const hit = cache[key];
  if (!force && hit && Date.now() - hit.at < ttlMs) return hit.data;
  const data = await loader();
  cache[key] = { at: Date.now(), data };
  return data;
}

// /api/user/: account details (+ possibly plans on some installs)
const getCatalog = (force = false) => cached('user', async () => (await client().get('/user/')).data, 5 * 60 * 1000, force);

// /api/v1/base/: public catalogue of IDs (network, cable, disco, exam). May not exist.
async function getBase() {
  try {
    return await cached('base', async () => {
      const { data } = await axios.get(`${baseURL()}/v1/base/`, { timeout: 20000 });
      if (!data || typeof data !== 'object') throw new Error('not json');
      return data;
    }, 10 * 60 * 1000);
  } catch (e) {
    return null;
  }
}

// Optional dedicated plan lists (/network/ and /cable/). Fall back to /user/.
async function getPlanSource(kind) {
  const path = kind === 'data' ? '/network/' : '/cable/';
  try {
    return await cached(`plans:${kind}`, async () => (await client().get(path)).data);
  } catch (e) {
    const cat = await getCatalog();
    return kind === 'data' ? cat.Dataplans || cat.dataplans || cat.DataPlans || cat : cat.Cableplan || cat.cableplan || cat.CablePlan || cat;
  }
}

// Find an item {id, name} in a catalogue list whose name contains the brand.
function findInLists(sources, keyPattern, brand) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [key, value] of Object.entries(src)) {
      if (!keyPattern.test(key) || !Array.isArray(value)) continue;
      const hit = value.find((item) => {
        const label = norm(Object.entries(item).filter(([k]) => k !== 'id').map(([, v]) => v).join(' '));
        return label.includes(norm(brand));
      });
      if (hit && hit.id !== undefined) return hit;
    }
  }
  return null;
}

async function lookup(kind, key) {
  // kind: 'network' | 'cable' | 'disco'
  const k = String(key).toLowerCase();
  const cfg = {
    network: { env: 'ARRIFQU_NETWORK_IDS', fallback: FALLBACK_NETWORK, pattern: /^network/i, brand: k },
    cable: { env: 'ARRIFQU_CABLE_IDS', fallback: FALLBACK_CABLE, pattern: /^cable$|^cables$|^cablename/i, brand: k === 'startimes' ? 'startime' : k },
    disco: { env: 'ARRIFQU_DISCO_IDS', fallback: FALLBACK_DISCO, pattern: /disco/i, brand: k.split('-')[0] }
  }[kind];

  const overrides = envMap(cfg.env, {});
  if (overrides[k] !== undefined) return { id: overrides[k], name: null };

  try {
    const base = await getBase();
    const cat = base ? null : await getCatalog().catch(() => null);
    const hit = findInLists([base, cat], cfg.pattern, cfg.brand);
    if (hit) return { id: hit.id, name: hit.name || null };
  } catch (e) { /* use fallback */ }
  return { id: cfg.fallback[k], name: null };
}

const networkId = async (n) => (await lookup('network', n)).id;
const cableId = async (c) => (await lookup('cable', c)).id;
const discoId = async (d) => (await lookup('disco', d)).id;

// ---- Catalog: data plans & cable bouquets ----
function planLabel(p) {
  const base = p.plan_name || p.plan || p.package || p.name || p.cableplan || 'Plan';
  const parts = [p.plan_network && !String(base).toUpperCase().includes(String(p.plan_network).toUpperCase()) ? p.plan_network : null, base];
  const type = p.plan_type && !String(base).toUpperCase().includes(String(p.plan_type).toUpperCase()) ? p.plan_type : null;
  const validity = p.month_validate || p.validity || null;
  return [parts.filter(Boolean).join(' '), type, validity].filter(Boolean).join(' - ');
}

async function getVariations(kind, providerName) {
  if (!isLive()) {
    if (kind === 'exam') return MOCK_CATALOG.exam;
    return MOCK_CATALOG[kind]?.[providerName] || [];
  }

  try {
    if (kind === 'exam') {
      // Offered only if the provider's public catalogue lists exam pins.
      const base = await getBase();
      return (base?.exam || [])
        .filter((e) => e && e.exam_name && num(e.amount) > 0)
        .map((e) => ({ serviceID: String(e.exam_name), variation_code: String(e.exam_name), name: `${e.exam_name} Result Checker PIN`, amount: num(e.amount) }));
    }

    if (kind === 'data') {
      const id = await networkId(providerName);
      const brand = norm(providerName);
      const source = await getPlanSource('data');
      const plans = collectArrays(source).flat().filter((p) => p && (p.plan_amount !== undefined || p.amount !== undefined));
      return plans
        .filter((p) => {
          const byName = p.plan_network && norm(p.plan_network).includes(brand);
          const byId = id !== undefined && id !== null && String(p.network) === String(id);
          return byName || byId;
        })
        .map((p) => ({ variation_code: String(p.id), name: planLabel(p), amount: num(p.plan_amount ?? p.amount) }))
        .filter((p) => p.variation_code && Number.isFinite(p.amount) && p.amount > 0);
    }

    if (kind === 'cable') {
      const id = await cableId(providerName);
      const brand = norm(providerName === 'startimes' ? 'startime' : providerName);
      const source = await getPlanSource('cable');
      const plans = collectArrays(source).flat().filter((p) => p && (p.plan_amount !== undefined || p.amount !== undefined));
      return plans
        .filter((p) => {
          const byId = typeof (p.cable ?? p.cablename) === 'number' && id !== undefined && id !== null && String(p.cable ?? p.cablename) === String(id);
          const byName = norm(p.cable_name || p.cablename || p.cable || p.package || '').includes(brand);
          return byId || byName;
        })
        .map((p) => ({ variation_code: String(p.id), name: planLabel(p), amount: num(p.plan_amount ?? p.amount) }))
        .filter((p) => p.variation_code && Number.isFinite(p.amount) && p.amount > 0);
    }
  } catch (err) {
    console.error('Arrifqubundle catalog error:', err.response?.status, JSON.stringify(err.response?.data) || err.message);
  }
  return [];
}

// ---- Customer verification (meter number / smartcard) ----
function readName(d) {
  return d?.name || d?.Customer_Name || d?.customer_name || d?.customerName || d?.account_name || '';
}

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

// Arrifqubundle's docs pass IDs (disconame=1, cablename=2); ASBData's docs pass
// names (disconame=Ikeja Electric, cablename=DSTV). Try IDs first, then names.
async function verifyCustomer({ kind, disco, meterType, meter, provider, smartcardNumber }) {
  if (!isLive()) {
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, customerName: 'MOCK CUSTOMER', details: {} };
  }

  const fail = { ok: false, message: 'We could not verify those details. Please check the number and try again.' };
  try {
    if (kind === 'electricity') {
      const d = await lookup('disco', disco);
      if (d.id === undefined || d.id === null) return { ok: false, message: 'That electricity provider is not available right now.' };
      const typeName = meterType === 'postpaid' ? 'Postpaid' : 'Prepaid';
      return (
        (await tryValidate('/validatemeter', { meternumber: meter, disconame: d.id, mtype: meterType === 'postpaid' ? 2 : 1 })) ||
        (d.name && (await tryValidate('/validatemeter', { meternumber: meter, disconame: d.name, mtype: typeName }))) ||
        fail
      );
    }
    if (kind === 'cable') {
      const c = await lookup('cable', provider);
      if (c.id === undefined || c.id === null) return { ok: false, message: 'That cable provider is not available right now.' };
      const nameGuess = c.name || (provider === 'startimes' ? 'STARTIME' : String(provider).toUpperCase());
      return (
        (await tryValidate('/validateiuc', { smart_card_number: smartcardNumber, cablename: c.id })) ||
        (await tryValidate('/validateiuc', { smart_card_number: smartcardNumber, cablename: nameGuess })) ||
        fail
      );
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
  // The provider can answer 200 with plain text "Forbidden." when the account has an
  // allowed-IP rule and this server's IP isn't on it. Nothing was bought in that case.
  if (typeof data === 'string') {
    if (/forbidden/i.test(data)) {
      console.error('Provider replied "Forbidden": add this server\'s outbound IPs to the allowed IP list in your provider account (or remove the IP lock).');
      return { state: 'failed', message: 'This service is temporarily unavailable. Please try again shortly.', providerId: null, token: null, cards: null, raw: data };
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

function errorText(data) {
  try {
    return typeof data === 'string' ? data : JSON.stringify(data);
  } catch (e) {
    return '';
  }
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
      token: kind === 'electricity' ? 'Token : 1234-5678-9012-3456-7890' : null
    };
  }

  if (!process.env.ARRIFQU_API_KEY) {
    console.error('ARRIFQU_API_KEY is not set.');
    return { ok: false, state: 'failed', request_id, message: 'This service is temporarily unavailable. Please try again shortly.' };
  }

  let body;
  try {
    switch (kind) {
      case 'airtime':
        body = { network: await networkId(payload.network), amount: payload.amount, mobile_number: payload.phone, Ported_number: true, airtime_type: 'VTU' };
        break;
      case 'data':
        body = { network: await networkId(payload.network), mobile_number: payload.phone, plan: Number(payload.variation_code) || payload.variation_code, Ported_number: true, customer_ref: request_id };
        break;
      case 'electricity':
        body = { disco_name: await discoId(payload.disco), amount: payload.amount, meter_number: payload.meter, MeterType: meterTypeValue(payload.variation_code), Customer_Phone: payload.phone };
        break;
      case 'cable':
        body = { cablename: await cableId(payload.provider), cableplan: Number(payload.variation_code) || payload.variation_code, smart_card_number: payload.smartcardNumber };
        break;
      case 'exam':
        body = { exam_name: payload.variation_code, quantity: payload.quantity || 1 };
        break;
      default:
        return { ok: false, state: 'failed', request_id, message: 'This service is not available right now.' };
    }
  } catch (err) {
    return { ok: false, state: 'failed', request_id, message: 'This service is temporarily unavailable. Please try again shortly.' };
  }

  const missingId = Object.entries(body).find(([k, v]) => ['network', 'disco_name', 'cablename'].includes(k) && (v === undefined || v === null));
  if (missingId) {
    console.error(`Arrifqubundle: no ID known for ${kind} (${missingId[0]}). Check the Provider check page / ID overrides.`);
    return { ok: false, state: 'failed', request_id, message: 'This service is temporarily unavailable. Please try again shortly.' };
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
            : 'Transaction failed. You have not been charged.'
      };
    }
    // Timeout / network drop / 5xx: the order MAY have gone through. Don't refund yet.
    console.error('Arrifqubundle purchase: unclear outcome, marking pending:', status || err.message);
    return { ok: false, state: 'pending', request_id, message: 'Your order is being processed.' };
  }
}

// ---- Look up a transaction by the provider's own id ----
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
function findBalance(obj) {
  const seen = [];
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(o)) {
      if (/balance/i.test(k) && !/before|after/i.test(k) && Number.isFinite(num(v)) && v !== null && typeof v !== 'object') {
        seen.push({ k, v, depth });
      } else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, depth + 1);
    }
  })(obj, 0);
  if (!seen.length) return NaN;
  const preferred = seen.find((s) => /account_?balance/i.test(s.k)) || seen[0];
  return num(preferred.v);
}

async function getBalance() {
  if (!isLive()) return { ok: true, balance: 250000, mock: true };
  try {
    const data = await getCatalog(true);
    const balance = findBalance(data?.user ?? data);
    if (!Number.isFinite(balance)) {
      return { ok: false, message: 'Connected, but could not find the balance in the provider response. Use "Provider check" and send me the result.' };
    }
    return { ok: true, balance };
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
      Object.entries(node).map(([k, v]) => [k, /token|password|secret|key|pin/i.test(k) ? '[hidden]' : summarise(v, depth + 1)])
    );
  }
  return node;
}

async function diagnostics() {
  if (!isLive()) return { mode: 'mock', note: 'Set PROVIDER_MODE=live and ARRIFQU_API_KEY to inspect the real provider response.' };
  try {
    const user = await getCatalog(true);
    const base = await getBase();
    const warnings = [];
    if (!base) warnings.push('Public catalogue /v1/base/ not available: IDs come from /user/ or fallback guesses. Verify them below.');
    else if (!(base.exam || []).length) warnings.push('Exam PINs not listed by the provider: that service stays "Coming soon".');
    const userType = user?.user_type || user?.user?.user_type || null;
    if (userType && String(userType).toUpperCase() !== 'API') {
      warnings.push(`Account type is "${userType}". Some providers allow only 1 purchase per minute unless the account type is API. Ask support if customers hit "Too many requests".`);
    }
    return {
      mode: 'live',
      baseURL: baseURL(),
      accountType: userType,
      warnings,
      catalogueFound: !!base,
      networkIds: { mtn: await networkId('mtn'), glo: await networkId('glo'), '9mobile': await networkId('9mobile'), airtel: await networkId('airtel') },
      cableIds: { dstv: await cableId('dstv'), gotv: await cableId('gotv'), startimes: await cableId('startimes') },
      discoIds: { 'ikeja-electric': await discoId('ikeja-electric'), 'eko-electric': await discoId('eko-electric'), 'abuja-electric': await discoId('abuja-electric') },
      examPins: (base?.exam || []).map((e) => `${e.exam_name}: ${e.amount}`),
      sampleDataPlans: (await getVariations('data', 'mtn')).slice(0, 3),
      sampleCablePlans: (await getVariations('cable', 'dstv')).slice(0, 3),
      detectedBalance: findBalance(user?.user ?? user),
      userResponse: summarise(user),
      catalogueResponse: summarise(base)
    };
  } catch (err) {
    return { mode: 'live', error: err.response?.status || err.message, body: summarise(err.response?.data) };
  }
}

module.exports = { getVariations, verifyCustomer, purchase, requery, findByRef, getBalance, diagnostics, MOCK_CATALOG };
