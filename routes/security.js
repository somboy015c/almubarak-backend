const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { requireAuth, requirePin } = require('../middleware/auth');
const { publicUser } = require('../utils/helpers');

const router = express.Router();

router.get('/status', requireAuth, (req, res) => {
  res.json({
    hasPin: !!req.user.transactionPin,
    hasBankAccount: !!(req.user.bankAccount && req.user.bankAccount.accountNumber)
  });
});

// Set a PIN for the first time, or change an existing one.
// Always requires the account password. If a PIN already exists, the
// current PIN must also be provided.
router.post('/pin', requireAuth, async (req, res) => {
  const { password, currentPin, newPin } = req.body;

  if (!newPin || !/^\d{4}$/.test(String(newPin))) {
    return res.status(400).json({ error: 'Your new PIN must be exactly 4 digits.' });
  }
  if (!password) {
    return res.status(400).json({ error: 'Please confirm your account password.' });
  }

  const user = await User.findOne({ id: req.user.id });
  const passwordMatch = await bcrypt.compare(password, user.password);
  if (!passwordMatch) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  if (user.transactionPin) {
    if (!currentPin) {
      return res.status(400).json({ error: 'Please enter your current PIN.' });
    }
    const pinMatch = await bcrypt.compare(String(currentPin), user.transactionPin);
    if (!pinMatch) {
      return res.status(401).json({ error: 'Your current PIN is incorrect.' });
    }
  }

  user.transactionPin = await bcrypt.hash(String(newPin), 10);
  await user.save();

  res.json({ message: 'Transaction PIN saved.', user: publicUser(user) });
});

// Save or update the bank account withdrawals get paid into.
// Requires the transaction PIN so a hijacked session can't quietly
// redirect future payouts.
router.put('/bank-account', requireAuth, requirePin, async (req, res) => {
  const { bankName, accountNumber, accountName } = req.body;
  if (!bankName || !accountNumber || !accountName) {
    return res.status(400).json({ error: 'Bank name, account number and account name are all required.' });
  }

  const user = await User.findOne({ id: req.user.id });
  user.bankAccount = { bankName, accountNumber, accountName };
  await user.save();

  res.json({ message: 'Withdrawal bank account saved.', user: publicUser(user) });
});

module.exports = router;
