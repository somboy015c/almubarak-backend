const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const AirtimeToCash = require('../models/AirtimeToCash');
const { getOrCreatePricing } = require('../models/Pricing');
const { requireAuth, requirePin } = require('../middleware/auth');
const { generateRef, round2 } = require('../utils/helpers');
const { frontendUrl } = require('../utils/urls');
const airtimeToCashProvider = require('../services/airtimeToCashProvider');
const { notifyA2C, alertAdmin, money } = require('../services/notify');
const { getSettings, isServiceOn } = require('../models/Settings');

const router = express.Router();

const NETWORKS = ['mtn', 'airtel', 'glo', '9mobile'];
const LABEL = { mtn: 'MTN', airtel: 'Airtel', glo: 'Glo', '9mobile': '9mobile' };
const MIN_AMOUNT = 100;

// Manual mode only offers networks where the owner has typed a receiving number.
const configuredLines = (settings) =>
  NETWORKS.filter((n) => settings.a2cLines && String(settings.a2cLines[n] || '').trim()).map((n) => ({ network: n, label: LABEL[n] }));

// Step 0: what can the customer choose?
router.get('/options', requireAuth, async (req, res) => {
  const [settings, pricing] = await Promise.all([getSettings(), getOrCreatePricing()]);
  res.json({
    ratePercent: pricing.airtimeToCash.ratePercent,
    minAmount: MIN_AMOUNT,
    manualLines: configuredLines(settings),
    autoEnabled: isServiceOn(settings, 'airtime-to-cash-auto')
  });
});

// Step 1 -> 2: the customer picked a line and an amount. We show what they will be paid and WHERE to send the airtime.
router.post('/prepare', requireAuth, async (req, res) => {
  const network = String(req.body.network || '').toLowerCase();
  const amount = Number(req.body.amountSent);
  if (!NETWORKS.includes(network)) return res.status(400).json({ error: 'Choose a network.' });
  if (!amount || amount < MIN_AMOUNT) return res.status(400).json({ error: `Enter the amount of airtime you will send (minimum ₦${MIN_AMOUNT}).` });

  const [settings, pricing] = await Promise.all([getSettings(), getOrCreatePricing()]);
  const sendTo = String((settings.a2cLines && settings.a2cLines[network]) || '').trim();
  if (!sendTo) return res.status(400).json({ error: `${LABEL[network]} is not available for airtime to cash right now.` });

  const rate = pricing.airtimeToCash.ratePercent;
  res.json({ network, label: LABEL[network], amountSent: amount, ratePercent: rate, cashValue: round2(amount * (rate / 100)), sendTo });
});

// Final step: the customer says they have sent the airtime. This places the request.
router.post('/', requireAuth, requirePin, async (req, res) => {
  const { amountSent, phoneUsed, method } = req.body;
  const network = String(req.body.network || '').toLowerCase();
  const numericAmount = Number(amountSent);
  // Automatic verification only runs while the admin has switched it on (it starts OFF).
  const settings = await getSettings();
  const autoOn = isServiceOn(settings, 'airtime-to-cash-auto');
  const chosenMethod = method === 'automatic' && autoOn ? 'automatic' : 'manual';
  const downgraded = method === 'automatic' && !autoOn;

  if (!NETWORKS.includes(network) || !phoneUsed) {
    return res.status(400).json({ error: 'Network and the phone number used are required.' });
  }
  if (!numericAmount || numericAmount < MIN_AMOUNT) {
    return res.status(400).json({ error: `Enter the amount of airtime you sent (minimum ₦${MIN_AMOUNT}).` });
  }

  // Manual: the owner's receiving number for this network must exist, and the customer must confirm the transfer.
  const sendToNumber = String((settings.a2cLines && settings.a2cLines[network]) || '').trim();
  if (chosenMethod === 'manual') {
    if (!sendToNumber) return res.status(400).json({ error: `${LABEL[network]} is not available for airtime to cash right now.` });
    if (req.body.confirmedSent !== true) return res.status(400).json({ error: 'Please confirm that you have sent the airtime.' });
  }

  const pricing = await getOrCreatePricing();
  const rate = pricing.airtimeToCash.ratePercent;
  const cashValue = round2(numericAmount * (rate / 100));

  const reference = generateRef('A2C');
  const transaction = await Transaction.create({
    id: uuidv4(),
    userId: req.user.id,
    type: 'airtime2cash',
    description: `${network.toUpperCase()} airtime to cash (₦${numericAmount} sent)`,
    amount: cashValue,
    status: 'pending',
    reference
  });

  const request = await AirtimeToCash.create({
    id: uuidv4(),
    userId: req.user.id,
    network,
    amountSent: numericAmount,
    cashValue,
    phoneUsed,
    sendToNumber: chosenMethod === 'manual' ? sendToNumber : '',
    customerConfirmed: chosenMethod === 'manual',
    method: chosenMethod,
    status: 'pending',
    transactionId: transaction.id
  });

  const requester = await User.findOne({ id: req.user.id });
  const info = { network, amountSent: numericAmount, cashValue };
  const queued = () => {
    notifyA2C(requester, { ...info, state: 'pending' });
    alertAdmin({
      level: 'warning',
      title: `Airtime-to-cash request: ${money(numericAmount)} ${String(network).toUpperCase()}`,
      message: `${requester.fullName} says they have sent airtime and is waiting for ${money(cashValue)} in their wallet. Check that it arrived on your line, then approve or reject it in Admin > Airtime to cash requests.`,
      rows: [
        ['Customer', `${requester.fullName} (${requester.email})`],
        ['Network', String(network).toUpperCase()],
        ['Airtime they say they sent', money(numericAmount)],
        ['Sent FROM this number', phoneUsed],
        ['Sent TO your line', sendToNumber || ''],
        ['Rate', `${rate}%`],
        ['They will be credited', money(cashValue)],
        ['Reference', reference]
      ],
      button: { text: 'Open the request', url: `${frontendUrl()}/admin.html#airtime2cash` }
    });
  };

  if (chosenMethod === 'manual') {
    queued();
    return res.json({
      message: `${downgraded ? 'Automatic verification is not available right now, so your request was sent for manual review. ' : ''}Request placed. Once we confirm your airtime arrived, ₦${cashValue.toLocaleString()} (${rate}% of ₦${numericAmount.toLocaleString()}) will be added to your wallet. We will email you.`
    });
  }

  // ---- Automatic verification path (OFF by default) ----
  const result = await airtimeToCashProvider.verify({ network, amountSent: numericAmount, phoneUsed });

  if (result.fellBackToManual) {
    queued();
    return res.json({
      message: `No automatic verification provider is configured yet, so this was queued for manual review instead. You'll receive ₦${cashValue.toLocaleString()} once verified.`
    });
  }

  if (!result.ok || !result.verified) {
    request.status = 'failed';
    request.adminNote = result.message || 'Automatic verification failed.';
    await request.save();
    transaction.status = 'failed';
    await transaction.save();
    notifyA2C(requester, { ...info, state: 'failed', note: result.message });
    return res.status(422).json({ error: result.message || 'We could not verify that airtime was received.' });
  }

  await User.updateOne({ id: req.user.id }, { $inc: { walletBalance: cashValue } });

  request.status = 'success';
  request.adminNote = 'Verified automatically';
  await request.save();
  transaction.status = 'success';
  await transaction.save();

  notifyA2C(requester, { ...info, state: 'success' });
  res.json({ message: `Verified! ₦${cashValue.toLocaleString()} has been added to your wallet.` });
});

module.exports = router;
