const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { getOrCreatePricing, Pricing } = require('../models/Pricing');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { publicUser } = require('../utils/helpers');

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/stats', async (req, res) => {
  const users = await User.find();
  const transactions = await Transaction.find();
  const successful = transactions.filter((t) => t.status === 'success');

  res.json({
    totalUsers: users.length,
    totalTransactions: transactions.length,
    totalRevenue: successful.reduce((sum, t) => sum + Number(t.amount), 0),
    totalWalletFloat: users.reduce((sum, u) => sum + Number(u.walletBalance), 0)
  });
});

router.get('/users', async (req, res) => {
  const users = await User.find();
  res.json({ users: users.map(publicUser) });
});

router.get('/transactions', async (req, res) => {
  const transactions = await Transaction.find().sort({ createdAt: -1 });
  res.json({ transactions });
});

// Manually credit or debit a user's wallet (e.g. reversing a failed provider charge)
router.post('/users/:id/wallet-adjust', async (req, res) => {
  const { amount, reason } = req.body;
  const numericAmount = Number(amount);
  if (!numericAmount) return res.status(400).json({ error: 'A non-zero amount is required.' });

  const user = await User.findOne({ id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found.' });

  user.walletBalance = Number(user.walletBalance) + numericAmount;
  await user.save();

  await Transaction.create({
    id: uuidv4(),
    userId: req.params.id,
    type: 'admin-adjustment',
    description: reason || 'Manual wallet adjustment by admin',
    amount: numericAmount,
    status: 'success',
    reference: `ADJ-${Date.now()}`
  });

  res.json({ message: 'Wallet updated.', user: publicUser(user) });
});

// Update markup/pricing
router.put('/pricing', async (req, res) => {
  await getOrCreatePricing();
  const updated = await Pricing.findByIdAndUpdate('singleton', req.body, { new: true });
  res.json({ pricing: updated });
});

router.get('/pricing', async (req, res) => {
  const pricing = await getOrCreatePricing();
  res.json({ pricing });
});

module.exports = router;
