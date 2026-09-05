const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { generateRef, applyMarkup, publicUser } = require('../utils/helpers');
const vtpass = require('../services/vtpass');

const router = express.Router();

// ---- Catalog (networks, data plans, cable bouquets, exam pins) ----

router.get('/data/plans/:network', requireAuth, async (req, res) => {
  const plans = await vtpass.getVariations('data', req.params.network);
  const pricing = db.get('pricing.data').value();
  const priced = plans.map((p) => ({ ...p, price: applyMarkup(p.amount, pricing.markupPercent) }));
  res.json({ plans: priced });
});

router.get('/cable/plans/:provider', requireAuth, async (req, res) => {
  const plans = await vtpass.getVariations('cable', req.params.provider);
  const pricing = db.get('pricing.cable').value();
  const priced = plans.map((p) => ({ ...p, price: applyMarkup(p.amount, pricing.markupPercent) }));
  res.json({ plans: priced });
});

router.get('/exam/plans', requireAuth, async (req, res) => {
  const plans = await vtpass.getVariations('exam');
  const pricing = db.get('pricing.exam').value();
  const priced = plans.map((p) => ({ ...p, price: p.amount + pricing.flatFee }));
  res.json({ plans: priced });
});

// ---- Shared purchase flow ----

function recordTransaction({ userId, type, description, amount, status, meta, request_id }) {
  const tx = {
    id: uuidv4(),
    userId,
    type,
    description,
    amount,
    status,
    reference: request_id,
    meta: meta || {},
    createdAt: new Date().toISOString()
  };
  db.get('transactions').push(tx).write();
  return tx;
}

async function chargeAndPurchase({ req, res, kind, amount, description, payload }) {
  const user = db.get('users').find({ id: req.user.id });
  const currentBalance = Number(user.value().walletBalance);

  if (currentBalance < amount) {
    return res.status(402).json({ error: 'Insufficient wallet balance. Please fund your wallet.' });
  }

  // Debit first, refund on failure — avoids a race where a slow provider
  // response lets the same balance be spent twice.
  user.assign({ walletBalance: currentBalance - amount }).write();

  const result = await vtpass.purchase(kind, payload);

  if (!result.ok) {
    user.assign({ walletBalance: currentBalance }).write(); // refund
    recordTransaction({
      userId: req.user.id,
      type: kind,
      description,
      amount,
      status: 'failed',
      meta: payload,
      request_id: result.request_id
    });
    return res.status(422).json({ error: result.message || 'Transaction failed. You have not been charged.' });
  }

  recordTransaction({
    userId: req.user.id,
    type: kind,
    description,
    amount,
    status: 'success',
    meta: payload,
    request_id: result.request_id
  });

  res.json({
    message: result.message,
    reference: result.request_id,
    user: publicUser(db.get('users').find({ id: req.user.id }).value())
  });
}

// ---- Airtime ----
router.post('/airtime', requireAuth, async (req, res) => {
  const { network, phone, amount } = req.body;
  if (!network || !phone || !amount) {
    return res.status(400).json({ error: 'Network, phone number and amount are required.' });
  }
  await chargeAndPurchase({
    req,
    res,
    kind: 'airtime',
    amount: Number(amount),
    description: `${network.toUpperCase()} airtime to ${phone}`,
    payload: { network, phone, amount: Number(amount) }
  });
});

// ---- Data ----
router.post('/data', requireAuth, async (req, res) => {
  const { network, phone, variation_code, amount } = req.body;
  if (!network || !phone || !variation_code || !amount) {
    return res.status(400).json({ error: 'Network, phone number and a data plan are required.' });
  }
  await chargeAndPurchase({
    req,
    res,
    kind: 'data',
    amount: Number(amount),
    description: `${network.toUpperCase()} data to ${phone}`,
    payload: { network, phone, variation_code, amount: Number(amount) }
  });
});

// ---- Electricity ----
router.post('/electricity', requireAuth, async (req, res) => {
  const { disco, meter, meterType, phone, amount } = req.body;
  if (!disco || !meter || !meterType || !phone || !amount) {
    return res.status(400).json({ error: 'Disco, meter number, meter type, phone and amount are required.' });
  }
  await chargeAndPurchase({
    req,
    res,
    kind: 'electricity',
    amount: Number(amount),
    description: `${disco.toUpperCase()} ${meterType} - meter ${meter}`,
    payload: { disco, meter, variation_code: meterType, phone, amount: Number(amount) }
  });
});

// ---- Cable TV ----
router.post('/cable', requireAuth, async (req, res) => {
  const { provider, smartcardNumber, variation_code, phone, amount } = req.body;
  if (!provider || !smartcardNumber || !variation_code || !phone || !amount) {
    return res.status(400).json({ error: 'Provider, smartcard number and bouquet are required.' });
  }
  await chargeAndPurchase({
    req,
    res,
    kind: 'cable',
    amount: Number(amount),
    description: `${provider.toUpperCase()} - card ${smartcardNumber}`,
    payload: { provider, smartcardNumber, variation_code, phone, amount: Number(amount) }
  });
});

// ---- Exam pins ----
router.post('/exam', requireAuth, async (req, res) => {
  const { examBody, variation_code, phone, amount, quantity } = req.body;
  if (!examBody || !variation_code || !phone || !amount) {
    return res.status(400).json({ error: 'Exam body and PIN type are required.' });
  }
  await chargeAndPurchase({
    req,
    res,
    kind: 'exam',
    amount: Number(amount) * (quantity || 1),
    description: `${examBody.toUpperCase()} PIN x${quantity || 1}`,
    payload: { examBody, variation_code, phone, quantity: quantity || 1 }
  });
});

module.exports = router;
