const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('../utils/helpers');
const paystack = require('../services/paystack');

const router = express.Router();

// Start a wallet funding transaction
router.post('/fund/initialize', requireAuth, async (req, res) => {
  const { amount } = req.body;
  const numericAmount = Number(amount);

  if (!numericAmount || numericAmount < 100) {
    return res.status(400).json({ error: 'Enter an amount of at least ₦100.' });
  }

  const result = await paystack.initializeFunding({ email: req.user.email, amount: numericAmount });
  if (!result.ok) {
    return res.status(502).json({ error: result.message || 'Could not start payment.' });
  }

  db.get('fundings')
    .push({
      id: uuidv4(),
      userId: req.user.id,
      reference: result.reference,
      amount: numericAmount,
      status: 'pending',
      createdAt: new Date().toISOString()
    })
    .write();

  res.json({
    reference: result.reference,
    authorization_url: result.authorization_url,
    mock: !!result.mock
  });
});

// Confirm a funding transaction (called after Paystack redirect, or immediately in mock mode)
router.post('/fund/verify', requireAuth, async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'A payment reference is required.' });

  const funding = db.get('fundings').find({ reference }).value();
  if (!funding) return res.status(404).json({ error: 'We could not find that payment.' });
  if (funding.userId !== req.user.id) return res.status(403).json({ error: 'This payment does not belong to your account.' });
  if (funding.status === 'success') {
    return res.json({ message: 'Already credited.', user: publicUser(req.user) });
  }

  const result = await paystack.verifyFunding(reference);
  if (!result.ok) {
    db.get('fundings').find({ reference }).assign({ status: 'failed' }).write();
    return res.status(402).json({ error: 'Payment could not be verified.' });
  }

  db.get('fundings').find({ reference }).assign({ status: 'success' }).write();

  const user = db.get('users').find({ id: req.user.id });
  const newBalance = Number(user.value().walletBalance) + Number(funding.amount);
  user.assign({ walletBalance: newBalance }).write();

  res.json({ message: 'Wallet funded successfully.', user: publicUser(user.value()) });
});

router.get('/balance', requireAuth, (req, res) => {
  res.json({ walletBalance: req.user.walletBalance });
});

module.exports = router;
