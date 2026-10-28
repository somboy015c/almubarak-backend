const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Funding = require('../models/Funding');
const { requireAuth } = require('../middleware/auth');
const { requireService } = require('../middleware/services');
const { publicUser } = require('../utils/helpers');
const flutterwave = require('../services/flutterwave');
const { settleFunding } = require('../services/funding');

const router = express.Router();

router.post('/fund/initialize', requireAuth, requireService('funding'), async (req, res) => {
  const numericAmount = Number(req.body.amount);

  if (!numericAmount || numericAmount < 100) {
    return res.status(400).json({ error: 'Enter an amount of at least ₦100.' });
  }
  if (numericAmount > 1000000) {
    return res.status(400).json({ error: 'Maximum single funding is ₦1,000,000.' });
  }

  const result = await flutterwave.initializeFunding({
    email: req.user.email,
    amount: numericAmount,
    name: req.user.fullName,
    phone: req.user.phone
  });
  if (!result.ok) {
    return res.status(502).json({ error: result.message || 'Could not start payment.' });
  }

  await Funding.create({
    id: uuidv4(),
    userId: req.user.id,
    reference: result.reference,
    amount: numericAmount,
    status: 'pending'
  });

  res.json({
    reference: result.reference,
    authorization_url: result.authorization_url,
    mock: !!result.mock
  });
});

// Called by the dashboard when the customer returns from Flutterwave (or on a
// retry). The Flutterwave webhook credits the wallet independently as a backup.
router.post('/fund/verify', requireAuth, async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'A payment reference is required.' });

  const funding = await Funding.findOne({ reference });
  if (!funding) return res.status(404).json({ error: 'We could not find that payment.' });
  if (funding.userId !== req.user.id) return res.status(403).json({ error: 'This payment does not belong to your account.' });

  const result = await settleFunding(reference);
  const user = await User.findOne({ id: req.user.id });

  if (result.state === 'success') {
    return res.json({
      message: result.order ? (result.order.message || 'Payment received.') : result.alreadyCredited ? 'Payment already credited.' : 'Wallet funded successfully.',
      state: 'success',
      order: result.order || null,
      user: publicUser(user)
    });
  }
  if (result.state === 'pending') {
    return res.status(202).json({
      message: 'We have not received confirmation of this payment yet. If you paid, your wallet will be credited automatically within a few minutes.',
      state: 'pending',
      user: publicUser(user)
    });
  }
  return res.status(402).json({ error: 'This payment was not successful, so your wallet was not credited.', state: 'failed' });
});

router.get('/balance', requireAuth, (req, res) => {
  res.json({ walletBalance: req.user.walletBalance });
});

module.exports = router;
