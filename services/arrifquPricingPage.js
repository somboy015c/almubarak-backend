// Reads the supplier's own price list at https://arrifqubundle.com/pricing/.
//
// Why this exists: the API's "plan_amount" is always the Smart user price, even on an
// API-type account, so it overstates what this account really pays. The real price per
// account type is only published on the pricing page, which needs a normal website login
// (ARRIFQU_USERNAME / ARRIFQU_PASSWORD).
//
// The page has no plan IDs, so each row is paired with an API plan by network, size,
// validity and Smart price, in list order (both lists come out in the same order).
// A row that can't be paired, or a price that looks wrong, is ignored and the plan keeps
// its API price. That price is the higher one, so a failure here can't cause a loss.

const axios = require('axios');

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const money = (s) => {
  const m = String(s ?? '').match(/\d[\d,]*(?:\.\d+)?/);
  return m ? parseFloat(m[0].replace(/,/g, '')) : NaN;
};
const cellText = (html) =>
  html.replace(/<[^>]*>/g, ' ').replace(/&#8358;|&#x20A6;/gi, '₦').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Column headings differ between the page's tables and include the site's own misspellings.
const TIER_BY_HEADING = {
  smartuser: 'smart', smartearner: 'smart',
  resseller: 'affiliate', reseller: 'affiliate', affilliate: 'affiliate', affiliate: 'affiliate',
  topuser: 'topuser',
  apiuser: 'api'
};
const TIER_BY_ACCOUNT = { smart: 'smart', smartearner: 'smart', smartuser: 'smart', affiliate: 'affiliate', affilliate: 'affiliate', reseller: 'affiliate', resseller: 'affiliate', topuser: 'topuser', api: 'api', apiuser: 'api' };
const TIER_LABEL = { smart: 'Smart user', affiliate: 'Reseller', topuser: 'Top user', api: 'API user' };

const tierForAccount = (type) => TIER_BY_ACCOUNT[norm(type)] || null;

function rowsOf(tableHtml) {
  return [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
    [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cellText(c[1]))
  );
}

function tierColumns(header) {
  const cols = {};
  header.forEach((h, i) => {
    const tier = TIER_BY_HEADING[norm(h)];
    if (tier) cols[tier] = i;
  });
  return cols;
}

// -> { data: { mtn: [{ size, validity, tiers: { smart, affiliate, topuser, api } }] }, exam: { WAEC: { tiers } } }
function parsePricingPage(html) {
  const result = { data: {}, exam: {} };
  let lastEnd = 0;
  for (const t of String(html).matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const before = cellText(String(html).slice(lastEnd, t.index));
    lastEnd = t.index + t[0].length;
    const rows = rowsOf(t[0]);
    if (rows.length < 2) continue;
    const header = rows[0];
    const cols = tierColumns(header);
    if (cols.smart === undefined) continue;

    const headingNorm = header.map(norm);
    const sizeCol = headingNorm.indexOf('plansize');
    if (sizeCol >= 0) {
      const heading = [...before.matchAll(/\b(MTN|GLO|AIRTEL|9MOBILE)\s+DATA\b/gi)].pop();
      if (!heading) continue;
      const validityCol = headingNorm.findIndex((h) => h === 'validity' || h === 'vadidity');
      const net = heading[1].toLowerCase();
      result.data[net] = rows.slice(1).filter((r) => r.length === header.length).map((r) => ({
        size: r[sizeCol],
        validity: validityCol >= 0 ? r[validityCol] : '',
        tiers: Object.fromEntries(Object.entries(cols).map(([tier, i]) => [tier, money(r[i])]))
      }));
    } else if (headingNorm[0] === 'services') {
      for (const r of rows.slice(1)) {
        const exam = String(r[0] || '').match(/^(WAEC|NECO)\b/i);
        if (exam && r.length === header.length) {
          result.exam[exam[1].toUpperCase()] = { tiers: Object.fromEntries(Object.entries(cols).map(([tier, i]) => [tier, money(r[i])])) };
        }
      }
    }
  }
  return result;
}

// A believable tier price is positive, no more than the Smart price and not under half of it.
const sane = (cost, smart) => Number.isFinite(cost) && Number.isFinite(smart) && cost > 0 && cost <= smart && cost >= smart * 0.5;

// apiPlans: the API's raw list, in its own order. Returns Map(plan id -> real price).
function matchPlanCosts(apiPlans, pageRows, tier) {
  const costs = new Map();
  if (!tier || !Array.isArray(pageRows)) return costs;
  const queues = new Map();
  for (const row of pageRows) {
    const key = `${norm(row.size)}|${norm(row.validity)}|${row.tiers.smart}`;
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(row);
  }
  for (const plan of apiPlans) {
    const smart = money(plan.plan_amount);
    const row = queues.get(`${norm(plan.plan)}|${norm(plan.month_validate)}|${smart}`)?.shift();
    if (row && sane(row.tiers[tier], smart)) costs.set(String(plan.id), row.tiers[tier]);
  }
  return costs;
}

// ---- Website login ----
const siteURL = () => (process.env.ARRIFQU_SITE_URL || 'https://arrifqubundle.com').replace(/\/+$/, '');
const hasCredentials = () => Boolean(process.env.ARRIFQU_USERNAME && process.env.ARRIFQU_PASSWORD);
const http = () => axios.create({ timeout: 20000, maxRedirects: 0, responseType: 'text', validateStatus: (s) => s < 500, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ElmubarakPriceSync/1.0)' } });

let cookies = {};
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
function keepCookies(res) {
  for (const c of res.headers['set-cookie'] || []) {
    const [pair] = c.split(';');
    const at = pair.indexOf('=');
    if (at > 0) cookies[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
}

async function login() {
  cookies = {};
  const page = await http().get(`${siteURL()}/login/`);
  keepCookies(page);
  const csrf = String(page.data).match(/name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)/i)?.[1];
  if (!csrf) throw new Error('The supplier login page has changed.');
  const res = await http().post(
    `${siteURL()}/login/`,
    new URLSearchParams({ csrfmiddlewaretoken: csrf, username: process.env.ARRIFQU_USERNAME, password: process.env.ARRIFQU_PASSWORD }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(), Referer: `${siteURL()}/login/` } }
  );
  keepCookies(res);
  if (!cookies.sessionid) throw new Error('The supplier refused the website login. Check ARRIFQU_USERNAME and ARRIFQU_PASSWORD.');
}

async function fetchPricingHtml() {
  const get = () => http().get(`${siteURL()}/pricing/`, { headers: { Cookie: cookieHeader() } });
  let res = cookies.sessionid ? await get() : null;
  if (!res || res.status !== 200) {
    await login();
    res = await get();
  }
  if (res.status !== 200) throw new Error(`The supplier pricing page answered ${res.status}.`);
  return String(res.data);
}

// ---- Remembered copy ----
const FRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const state = { page: null, at: 0, failedAt: 0, error: null, running: null };

function refresh() {
  if (state.running) return state.running;
  state.running = (async () => {
    try {
      const page = parsePricingPage(await fetchPricingHtml());
      if (!Object.keys(page.data).length) throw new Error('No price tables were found on the supplier pricing page.');
      Object.assign(state, { page, at: Date.now(), failedAt: 0, error: null });
    } catch (err) {
      state.failedAt = Date.now();
      state.error = err.message;
      console.error('Arrifqubundle pricing page error:', err.message);
    } finally {
      state.running = null;
    }
  })();
  return state.running;
}

// Returns the page's prices, or null when none are usable. Customers never wait for a refresh
// when a recent copy exists: they get that copy while a new one is fetched behind the scenes.
async function getPricingPage(force = false) {
  if (!hasCredentials()) {
    state.error = 'ARRIFQU_USERNAME and ARRIFQU_PASSWORD are not set on the server.';
    return null;
  }
  const age = Date.now() - state.at;
  const canRetry = Date.now() - state.failedAt > RETRY_MS;
  if (force) await refresh();
  else if (!state.page) { if (canRetry) await refresh(); }
  else if (age > FRESH_MS && canRetry) refresh();
  return state.page && Date.now() - state.at < MAX_AGE_MS ? state.page : null;
}

const pageStatus = () => ({ readAt: state.at ? new Date(state.at).toISOString() : null, error: state.error });

module.exports = { parsePricingPage, matchPlanCosts, getPricingPage, pageStatus, tierForAccount, TIER_LABEL, sane };
