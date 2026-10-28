const express = require('express');
const { getOrCreatePricing } = require('../models/Pricing');
const { getSettings, isServiceOn, SERVICES } = require('../models/Settings');
const { requireAuth } = require('../middleware/auth');
const { requireService } = require('../middleware/services');
const { applyMarkup, round2 } = require('../utils/helpers');
const { logEvent } = require('../utils/log');
const provider = require('../services/arrifqubundle');
const { executePurchase, startDirectPayment } = require('../services/orders');

const router = express.Router();

const NETWORKS = ['mtn', 'airtel', 'glo', '9mobile'];
const CABLES = ['dstv', 'gotv', 'startimes'];

// The provider wants 11 digits starting with 0 (08031234567). Accept +234 / 234 / no leading 0 and convert.
const cleanPhone = (p) => {
  const digits = String(p || '').replace(/[^\d+]/g, '');
  const m = digits.match(/^(?:\+?234|0)?([789][01]\d{8})$/);
  return m ? `0${m[1]}` : digits;
};
const validPhone = (p) => /^0[789][01]\d{8}$/.test(cleanPhone(p));

const unavailable = (res, msg) =>
  res.status(503).json({ error: msg || 'This option is currently unavailable.', code: 'SERVICE_DISABLED' });

// ---- What is switched on (the dashboard hides everything that is off) ----
router.get('/status', requireAuth, async (req, res) => {
  const s = await getSettings();
  const services = Object.fromEntries(SERVICES.map((k) => [k, isServiceOn(s, k)]));
  res.json({
    maintenance: s.maintenance,
    maintenanceMessage: s.maintenanceMessage,
    notice: s.notice,
    services,
    networks: Object.fromEntries(NETWORKS.map((n) => [n, !s.disabledNetworks.includes(n)])),
    cables: Object.fromEntries(CABLES.map((c) => [c, !s.disabledCables.includes(c)]))
  });
});

// ---- Catalogue (data plans, cable packages, exam pins, electricity companies) ----

router.get('/data/plans/:network', requireAuth, async (req, res) => {
  const network = req.params.network;
  if (!NETWORKS.includes(network)) return res.status(400).json({ error: 'Unknown network.' });
  const s = await getSettings();
  if (!isServiceOn(s, 'data') || s.disabledNetworks.includes(network)) return res.json({ plans: [], categories: [] });

  const [plans, pricing] = await Promise.all([provider.getVariations('data', network), getOrCreatePricing()]);
  const visible = plans
    .filter((p) => !s.disabledPlans.includes(`data:${p.variation_code}`) && !s.disabledCategories.includes(`${network}|${p.category}`))
    .map((p) => ({ ...p, price: applyMarkup(p.amount, pricing.data.markupPercent) }));

  const counts = {};
  visible.forEach((p) => { counts[p.category] = (counts[p.category] || 0) + 1; });
  const categories = Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ plans: visible, categories });
});

router.get('/cable/plans/:provider', requireAuth, async (req, res) => {
  const cable = req.params.provider;
  if (!CABLES.includes(cable)) return res.status(400).json({ error: 'Unknown cable provider.' });
  const s = await getSettings();
  if (!isServiceOn(s, 'cable') || s.disabledCables.includes(cable)) return res.json({ plans: [] });

  const [plans, pricing] = await Promise.all([provider.getVariations('cable', cable), getOrCreatePricing()]);
  res.json({
    plans: plans
      .filter((p) => !s.disabledPlans.includes(`cable:${p.variation_code}`))
      .map((p) => ({ ...p, price: applyMarkup(p.amount, pricing.cable.markupPercent) }))
  });
});

router.get('/exam/plans', requireAuth, async (req, res) => {
  const s = await getSettings();
  if (!isServiceOn(s, 'exam')) return res.json({ plans: [] });
  const [plans, pricing] = await Promise.all([provider.getVariations('exam'), getOrCreatePricing()]);
  res.json({
    plans: plans
      .filter((p) => !s.disabledPlans.includes(`exam:${p.variation_code}`))
      .map((p) => ({ ...p, price: round2(p.amount + pricing.exam.flatFee) }))
  });
});

router.get('/electricity/discos', requireAuth, async (req, res) => {
  const s = await getSettings();
  if (!isServiceOn(s, 'electricity')) return res.json({ discos: [] });
  const discos = await provider.getDiscos();
  res.json({ discos: discos.filter((d) => !s.disabledDiscos.includes(String(d.id))) });
});

// Rates/limits shown in forms (not sensitive, just current settings)
router.get('/limits', requireAuth, async (req, res) => {
  const pricing = await getOrCreatePricing();
  res.json({
    airtimeToCashRatePercent: pricing.airtimeToCash.ratePercent,
    minWithdrawal: pricing.withdrawal.minAmount,
    airtimeMarkupPercent: pricing.airtime.markupPercent,
    electricityMarkupPercent: pricing.electricity.markupPercent
  });
});

// ---- Verify a meter number / smartcard before paying ----
router.post('/verify', requireAuth, async (req, res) => {
  const { kind, disco, provider: cableProvider, meter, meterType, smartcardNumber } = req.body;

  let args;
  if (kind === 'electricity') {
    const d = (await provider.getDiscos()).find((x) => String(x.id) === String(disco));
    if (!d || !meter) return res.status(400).json({ error: 'Choose a distribution company and enter the meter number.' });
    args = { kind, discoId: d.id, discoName: d.name, meter: String(meter).trim(), meterType: meterType === 'postpaid' ? 'postpaid' : 'prepaid' };
  } else if (kind === 'cable') {
    if (!CABLES.includes(cableProvider) || !smartcardNumber) return res.status(400).json({ error: 'Choose a provider and enter the smartcard number.' });
    args = { kind, provider: cableProvider, smartcardNumber: String(smartcardNumber).trim() };
  } else {
    return res.status(400).json({ error: 'Unknown verification type.' });
  }

  const result = await provider.verifyCustomer(args);
  if (!result.ok) {
    logEvent({ category: 'provider', level: 'warn', action: 'verify.failed', message: `${kind} verification failed`, user: { id: req.user.id, email: req.user.email }, meta: { kind, provider: cableProvider || args.discoName } });
    return res.status(422).json({ error: result.message });
  }
  if (result.style === 'name') {
    logEvent({ category: 'provider', action: 'verify.style', message: `${kind} verification worked using names, not IDs`, meta: { kind } });
  }
  res.json({ customerName: result.customerName });
});

// ---- Shared: pay from the wallet, or pay this one order with Flutterwave ----
async function dispatch(req, res, order) {
  if (req.body.payWith === 'flutterwave') {
    const s = await getSettings();
    if (!isServiceOn(s, 'funding')) {
      return unavailable(res, 'Card and bank payments are currently unavailable. Please pay from your wallet.');
    }
    const out = await startDirectPayment({ user: req.user, order });
    return res.status(out.status).json(out.body);
  }
  const out = await executePurchase({ userId: req.user.id, ...order });
  res.status(out.status).json(out.body);
}

// ---- Airtime ----
router.post('/airtime', requireAuth, requireService('airtime'), async (req, res) => {
  const { network } = req.body;
  const phone = cleanPhone(req.body.phone);
  const amount = Number(req.body.amount);
  if (!NETWORKS.includes(network) || !phone || !amount) {
    return res.status(400).json({ error: 'Network, phone number and amount are required.' });
  }
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian phone number.' });
  if (amount < 50 || amount > 50000) return res.status(400).json({ error: 'Airtime amount must be between ₦50 and ₦50,000.' });
  const s = await getSettings();
  if (s.disabledNetworks.includes(network)) return unavailable(res, `${network.toUpperCase()} airtime is currently unavailable.`);

  const pricing = await getOrCreatePricing();
  await dispatch(req, res, {
    kind: 'airtime',
    price: applyMarkup(amount, pricing.airtime.markupPercent),
    description: `${network.toUpperCase()} airtime to ${phone}`,
    payload: { network, phone, amount, faceValue: amount }
  });
});

// ---- Data ----
router.post('/data', requireAuth, requireService('data'), async (req, res) => {
  const { network, variation_code } = req.body;
  const phone = cleanPhone(req.body.phone);
  if (!NETWORKS.includes(network) || !phone || !variation_code) {
    return res.status(400).json({ error: 'Network, phone number and a data plan are required.' });
  }
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian phone number.' });

  const s = await getSettings();
  if (s.disabledNetworks.includes(network)) return unavailable(res, `${network.toUpperCase()} data is currently unavailable.`);

  // The price comes from the provider catalogue, never from the browser.
  const plans = await provider.getVariations('data', network);
  const plan = plans.find((p) => p.variation_code === String(variation_code));
  if (!plan || s.disabledPlans.includes(`data:${plan.variation_code}`) || s.disabledCategories.includes(`${network}|${plan.category}`)) {
    return res.status(400).json({ error: 'That data plan is no longer available. Please pick another.' });
  }

  const pricing = await getOrCreatePricing();
  await dispatch(req, res, {
    kind: 'data',
    price: applyMarkup(plan.amount, pricing.data.markupPercent),
    description: `${network.toUpperCase()} ${plan.category} ${plan.name} to ${phone}`,
    payload: { network, phone, variation_code: plan.variation_code, planName: plan.name, category: plan.category }
  });
});

// ---- Electricity ----
router.post('/electricity', requireAuth, requireService('electricity'), async (req, res) => {
  const { meterType } = req.body;
  const meter = String(req.body.meter || '').trim();
  const phone = cleanPhone(req.body.phone);
  const amount = Number(req.body.amount);
  const disco = (await provider.getDiscos()).find((d) => String(d.id) === String(req.body.disco));
  if (!disco || !meter || !['prepaid', 'postpaid'].includes(meterType) || !phone || !amount) {
    return res.status(400).json({ error: 'Disco, meter number, meter type, phone and amount are required.' });
  }
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian phone number.' });
  if (amount < 500 || amount > 500000) return res.status(400).json({ error: 'Amount must be between ₦500 and ₦500,000.' });
  const s = await getSettings();
  if (s.disabledDiscos.includes(String(disco.id))) return unavailable(res, `${disco.name} is currently unavailable.`);

  const pricing = await getOrCreatePricing();
  await dispatch(req, res, {
    kind: 'electricity',
    price: applyMarkup(amount, pricing.electricity.markupPercent),
    description: `${disco.name} ${meterType} - meter ${meter}`,
    payload: { discoId: disco.id, discoName: disco.name, meter, variation_code: meterType, phone, amount, customerName: req.body.customerName || null }
  });
});

// ---- Cable TV ----
router.post('/cable', requireAuth, requireService('cable'), async (req, res) => {
  const { provider: cable, variation_code } = req.body;
  const smartcardNumber = String(req.body.smartcardNumber || '').trim();
  const phone = cleanPhone(req.body.phone);
  if (!CABLES.includes(cable) || !smartcardNumber || !variation_code || !phone) {
    return res.status(400).json({ error: 'Provider, smartcard number, bouquet and phone are required.' });
  }
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian phone number.' });
  const s = await getSettings();
  if (s.disabledCables.includes(cable)) return unavailable(res, `${cable.toUpperCase()} is currently unavailable.`);

  const plans = await provider.getVariations('cable', cable);
  const plan = plans.find((p) => p.variation_code === String(variation_code));
  if (!plan || s.disabledPlans.includes(`cable:${plan.variation_code}`)) {
    return res.status(400).json({ error: 'That bouquet is no longer available. Please pick another.' });
  }

  const pricing = await getOrCreatePricing();
  await dispatch(req, res, {
    kind: 'cable',
    price: applyMarkup(plan.amount, pricing.cable.markupPercent),
    description: `${cable.toUpperCase()} ${plan.name} - card ${smartcardNumber}`,
    payload: { provider: cable, smartcardNumber, variation_code: plan.variation_code, phone, planName: plan.name, planAmount: plan.amount, customerName: req.body.customerName || null }
  });
});

// ---- Exam pins ----
router.post('/exam', requireAuth, requireService('exam'), async (req, res) => {
  const { variation_code } = req.body;
  const phone = cleanPhone(req.body.phone);
  const quantity = Math.min(Math.max(parseInt(req.body.quantity, 10) || 1, 1), 5);
  if (!variation_code || !phone) {
    return res.status(400).json({ error: 'PIN type and phone number are required.' });
  }
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian phone number.' });

  const s = await getSettings();
  const plans = await provider.getVariations('exam');
  const plan = plans.find((p) => p.variation_code === String(variation_code));
  if (!plan || s.disabledPlans.includes(`exam:${plan.variation_code}`)) {
    return res.status(400).json({ error: 'Exam PINs are not available right now.' });
  }

  const pricing = await getOrCreatePricing();
  await dispatch(req, res, {
    kind: 'exam',
    price: round2((plan.amount + pricing.exam.flatFee) * quantity),
    description: `${plan.name} x${quantity}`,
    payload: { variation_code: plan.variation_code, phone, quantity, planName: plan.name, planAmount: plan.amount }
  });
});

module.exports = router;
