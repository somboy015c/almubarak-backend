const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const AirtimeToCash = require('../models/AirtimeToCash');
const { getOrCreatePricing } = require('../models/Pricing');
const { requireAuth, requirePin } = require('../middleware/auth');
const { generateRef } = require('../utils/helpers');
const airtimeToCashProvider = require('../services/airtimeToCashProvider');
const { notifyA2C, alertAdmin, money } = require('../services/notify');

const router = express.Router();

router.post('/', requireAuth, requirePin, async (req, res) => {
  const { network, amountSent, phoneUsed, method } = req.body;
  const numericAmount = Number(amountSent);
  const chosenMethod = method === 'automatic' ? 'automatic' : 'manual';

  if (!network || !phoneUsed) {
    return res.status(400).json({ error: 'Network and the phone number used are required.' });
  }
  if (!numericAmount || numericAmount < 100) {
    return res.status(400).json({ error: 'Enter the amount of airtime you sent (minimum ₦100).' });
  }

  const pricing = await getOrCreatePricing();
  const rate = pricing.airtimeToCash.ratePercent;
  const cashValue = Math.round(numericAmount * (rate / 100) * 100) / 100;

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
    method: chosenMethod,
    status: 'pending',
    transactionId: transaction.id
  });

  const requester = await User.findOne({ id: req.user.id });
  const info = { network, amountSent: numericAmount, cashValue };
  const queued = () => {
    notifyA2C(requester, { ...info, state: 'pending' });
    alertAdmin({ key: `a2c:${request.id}`, level: 'info', title: `Airtime-to-cash request: ${money(numericAmount)} ${String(network).toUpperCase()}`, message: `${requester.fullName} says they sent airtime and is waiting for ${money(cashValue)}. Check that it arrived, then approve or reject it in Admin > Airtime to cash.`, rows: [['Customer', `${requester.fullName} (${requester.email})`], ['Network', String(network).toUpperCase()], ['Airtime sent', money(numericAmount)], ['Phone used', phoneUsed], ['Will be credited', money(cashValue)]] });
  };

  if (chosenMethod === 'manual') {
    queued();
    return res.json({
      message: `Request submitted for manual review. You'll receive ₦${cashValue.toLocaleString()} (${rate}% of face value) once an admin verifies it.`
    });
  }

  // ---- Automatic verification path ----
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
