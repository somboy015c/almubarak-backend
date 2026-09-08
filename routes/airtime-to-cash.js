const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');
const AirtimeToCash = require('../models/AirtimeToCash');
const { getOrCreatePricing } = require('../models/Pricing');
const { requireAuth, requirePin } = require('../middleware/auth');
const { generateRef } = require('../utils/helpers');

const router = express.Router();

router.post('/', requireAuth, requirePin, async (req, res) => {
  const { network, amountSent, phoneUsed } = req.body;
  const numericAmount = Number(amountSent);

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

  await AirtimeToCash.create({
    id: uuidv4(),
    userId: req.user.id,
    network,
    amountSent: numericAmount,
    cashValue,
    phoneUsed,
    status: 'pending',
    transactionId: transaction.id
  });

  res.json({
    message: `Request submitted. You'll receive ₦${cashValue.toLocaleString()} (${rate}% of face value) once verified.`,
  });
});

module.exports = router;
