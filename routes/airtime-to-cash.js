const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const AirtimeToCash = require('../models/AirtimeToCash');
const { getOrCreatePricing } = require('../models/Pricing');
const { requireAuth, requirePin } = require('../middleware/auth');
const { generateRef } = require('../utils/helpers');
const airtimeToCashProvider = require('../services/airtimeToCashProvider');

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

  if (chosenMethod === 'manual') {
    return res.json({
      message: `Request submitted for manual review. You'll receive ₦${cashValue.toLocaleString()} (${rate}% of face value) once an admin verifies it.`
    });
  }

  // ---- Automatic verification path ----
  const result = await airtimeToCashProvider.verify({ network, amountSent: numericAmount, phoneUsed });

  if (result.fellBackToManual) {
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
    return res.status(422).json({ error: result.message || 'We could not verify that airtime was received.' });
  }

  const user = await User.findOne({ id: req.user.id });
  user.walletBalance = Number(user.walletBalance) + cashValue;
  await user.save();

  request.status = 'success';
  request.adminNote = 'Verified automatically';
  await request.save();
  transaction.status = 'success';
  await transaction.save();

  res.json({ message: `Verified! ₦${cashValue.toLocaleString()} has been added to your wallet.` });
});

module.exports = router;
