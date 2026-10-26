const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { getOrCreatePricing } = require('../models/Pricing');
const { requireAuth } = require('../middleware/auth');
const { applyMarkup, publicUser } = require('../utils/helpers');
const provider = require('../services/arrifqubundle');

const router = express.Router();

const NETWORKS = ['mtn', 'airtel', 'glo', '9mobile'];
const CABLES = ['dstv', 'gotv', 'startimes'];
const DISCOS = [
  'ikeja-electric', 'eko-electric', 'abuja-electric', 'kano-electric', 'portharcourt-electric',
  'ibadan-electric', 'jos-electric', 'kaduna-electric', 'enugu-electric', 'benin-electric',
  'yola-electric', 'aba-electric'
];

// The provider wants 11 digits starting with 0 (08031234567). Accept +234 / 234 / no leading 0 and convert.
const cleanPhone = (p) => {
  const digits = String(p || '').replace(/[^\d+]/g, '');
  const m = digits.match(/^(?:\+?234|0)?([789][01]\d{8})$/);
  return m ? `0${m[1]}` : digits;
};
const validPhone = (p) => /^0[789][01]\d{8}$/.test(cleanPhone(p));

// ---- Catalog (data plans, cable bouquets, exam pins) ----

router.get('/data/plans/:network', requireAuth, async (req, res) => {
  const plans = await provider.getVariations('data', req.params.network);
  const pricing = await getOrCreatePricing();
  res.json({ plans: plans.map((p) => ({ ...p, price: applyMarkup(p.amount, pricing.data.markupPercent) })) });
});

router.get('/cable/plans/:provider', requireAuth, async (req, res) => {
  const plans = await provider.getVariations('cable', req.params.provider);
  const pricing = await getOrCreatePricing();
  res.json({ plans: plans.map((p) => ({ ...p, price: applyMarkup(p.amount, pricing.cable.markupPercent) })) });
});

router.get('/exam/plans', requireAuth, async (req, res) => {
  const plans = await provider.getVariations('exam');
  const pricing = await getOrCreatePricing();
  res.json({ plans: plans.map((p) => ({ ...p, price: p.amount + pricing.exam.flatFee })) });
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
    if (!DISCOS.includes(disco) || !meter) return res.status(400).json({ error: 'Choose a distribution company and enter the meter number.' });
    args = { kind, disco, meter: String(meter).trim(), meterType: meterType === 'postpaid' ? 'postpaid' : 'prepaid' };
  } else if (kind === 'cable') {
    if (!CABLES.includes(cableProvider) || !smartcardNumber) return res.status(400).json({ error: 'Choose a provider and enter the smartcard number.' });
    args = { kind, provider: cableProvider, smartcardNumber: String(smartcardNumber).trim() };
  } else {
    return res.status(400).json({ error: 'Unknown verification type.' });
  }

  const result = await provider.verifyCustomer(args);
  if (!result.ok) return res.status(422).json({ error: result.message });
  res.json({ customerName: result.customerName });
});

// ---- Shared purchase flow ----

async function chargeAndPurchase({ req, res, kind, price, description, payload }) {
  price = Math.round(Number(price) * 100) / 100;
  if (!price || price <= 0) return res.status(400).json({ error: 'Invalid amount.' });

  // Atomic debit: succeeds only if the balance still covers the price. Two
  // simultaneous requests can never spend the same money twice.
  const debited = await User.findOneAndUpdate(
    { id: req.user.id, walletBalance: { $gte: price } },
    { $inc: { walletBalance: -price } },
    { new: true }
  );
  if (!debited) {
    return res.status(402).json({ error: 'Insufficient wallet balance. Please fund your wallet.', code: 'INSUFFICIENT_BALANCE' });
  }

  const result = await provider.purchase(kind, payload);

  const record = (status, extraMeta = {}) =>
    Transaction.create({
      id: uuidv4(),
      userId: req.user.id,
      type: kind,
      description,
      amount: price,
      status,
      reference: result.request_id,
      meta: { ...payload, providerId: result.providerId || null, providerCost: result.providerCost ?? null, ...extraMeta }
    });

  if (result.state === 'failed') {
    await User.updateOne({ id: req.user.id }, { $inc: { walletBalance: price } }); // refund
    await record('failed');
    const fresh = await User.findOne({ id: req.user.id });
    return res.status(422).json({
      error: result.message || 'Transaction failed. You have not been charged.',
      user: publicUser(fresh)
    });
  }

  if (result.state === 'pending') {
    // Outcome not confirmed yet: keep the money held, settle via webhook / re-query.
    await record('pending');
    const fresh = await User.findOne({ id: req.user.id });
    return res.status(202).json({
      pending: true,
      message: 'Your order is being processed. You will see the final status in Transactions shortly.',
      reference: result.request_id,
      user: publicUser(fresh)
    });
  }

  await record('success', { token: result.token || null, cards: result.cards || null });
  const fresh = await User.findOne({ id: req.user.id });
  res.json({
    message: result.message || 'Transaction successful',
    reference: result.request_id,
    token: result.token || null,
    cards: result.cards || null,
    user: publicUser(fresh)
  });
}

// ---- Airtime ----
router.post('/airtime', requireAuth, async (req, res) => {
  const { network } = req.body;
  const phone = cleanPhone(req.body.phone);
  const amount = Number(req.body.amount);
  if (!NETWORKS.includes(network) || !phone || !amount) {
    return res.status(400).json({ error: 'Network, phone number and amount are required.' });
  }
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian phone number.' });
  if (amount < 50 || amount > 50000) return res.status(400).json({ error: 'Airtime amount must be between ₦50 and ₦50,000.' });

  const pricing = await getOrCreatePricing();
  await chargeAndPurchase({
    req, res, kind: 'airtime',
    price: applyMarkup(amount, pricing.airtime.markupPercent),
    description: `${network.toUpperCase()} airtime to ${phone}`,
    payload: { network, phone, amount, faceValue: amount }
  });
});

// ---- Data ----
router.post('/data', requireAuth, async (req, res) => {
  const { network, variation_code } = req.body;
  const phone = cleanPhone(req.body.phone);
  if (!NETWORKS.includes(network) || !phone || !variation_code) {
    return res.status(400).json({ error: 'Network, phone number and a data plan are required.' });
  }
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian phone number.' });

  // The price comes from the provider catalog, never from the browser.
  const plans = await provider.getVariations('data', network);
  const plan = plans.find((p) => p.variation_code === variation_code);
  if (!plan) return res.status(400).json({ error: 'That data plan is no longer available. Please pick another.' });

  const pricing = await getOrCreatePricing();
  await chargeAndPurchase({
    req, res, kind: 'data',
    price: applyMarkup(plan.amount, pricing.data.markupPercent),
    description: `${network.toUpperCase()} ${plan.name} to ${phone}`,
    payload: { network, phone, variation_code, planName: plan.name }
  });
});

// ---- Electricity ----
router.post('/electricity', requireAuth, async (req, res) => {
  const { disco, meterType } = req.body;
  const meter = String(req.body.meter || '').trim();
  const phone = cleanPhone(req.body.phone);
  const amount = Number(req.body.amount);
  if (!DISCOS.includes(disco) || !meter || !['prepaid', 'postpaid'].includes(meterType) || !phone || !amount) {
    return res.status(400).json({ error: 'Disco, meter number, meter type, phone and amount are required.' });
  }
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian phone number.' });
  if (amount < 500 || amount > 500000) return res.status(400).json({ error: 'Amount must be between ₦500 and ₦500,000.' });

  const pricing = await getOrCreatePricing();
  await chargeAndPurchase({
    req, res, kind: 'electricity',
    price: applyMarkup(amount, pricing.electricity.markupPercent),
    description: `${disco.replace('-electric', '').toUpperCase()} ${meterType} - meter ${meter}`,
    payload: { disco, meter, variation_code: meterType, phone, amount, customerName: req.body.customerName || null }
  });
});

// ---- Cable TV ----
router.post('/cable', requireAuth, async (req, res) => {
  const { provider, variation_code } = req.body;
  const smartcardNumber = String(req.body.smartcardNumber || '').trim();
  const phone = cleanPhone(req.body.phone);
  if (!CABLES.includes(provider) || !smartcardNumber || !variation_code || !phone) {
    return res.status(400).json({ error: 'Provider, smartcard number, bouquet and phone are required.' });
  }
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian phone number.' });

  const plans = await provider.getVariations('cable', provider);
  const plan = plans.find((p) => p.variation_code === variation_code);
  if (!plan) return res.status(400).json({ error: 'That bouquet is no longer available. Please pick another.' });

  const pricing = await getOrCreatePricing();
  await chargeAndPurchase({
    req, res, kind: 'cable',
    price: applyMarkup(plan.amount, pricing.cable.markupPercent),
    description: `${provider.toUpperCase()} ${plan.name} - card ${smartcardNumber}`,
    payload: { provider, smartcardNumber, variation_code, phone, planName: plan.name, planAmount: plan.amount, customerName: req.body.customerName || null }
  });
});

// ---- Exam pins ----
router.post('/exam', requireAuth, async (req, res) => {
  const { variation_code } = req.body;
  const phone = cleanPhone(req.body.phone);
  const quantity = Math.min(Math.max(parseInt(req.body.quantity, 10) || 1, 1), 5);
  if (!variation_code || !phone) {
    return res.status(400).json({ error: 'PIN type and phone number are required.' });
  }
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid Nigerian phone number.' });

  const plans = await provider.getVariations('exam');
  const plan = plans.find((p) => p.variation_code === variation_code && (!req.body.examBody || p.serviceID === req.body.examBody));
  if (!plan) return res.status(400).json({ error: 'Exam PINs are not available right now.' });
  if (plan.needsProfile && !req.body.profileId) {
    return res.status(400).json({ error: 'Enter the JAMB profile code for this PIN.' });
  }

  const pricing = await getOrCreatePricing();
  await chargeAndPurchase({
    req, res, kind: 'exam',
    price: (plan.amount + pricing.exam.flatFee) * quantity,
    description: `${plan.name} x${quantity}`,
    payload: {
      examBody: plan.serviceID, variation_code, phone, quantity,
      planName: plan.name, planAmount: plan.amount,
      billersCode: plan.needsProfile ? String(req.body.profileId).trim() : undefined
    }
  });
});

module.exports = router;
