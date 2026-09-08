const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Withdrawal = require('../models/Withdrawal');
const AirtimeToCash = require('../models/AirtimeToCash');
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

// ---- Withdrawals ----
router.get('/withdrawals', async (req, res) => {
  const withdrawals = await Withdrawal.find().sort({ createdAt: -1 });
  res.json({ withdrawals });
});

router.post('/withdrawals/:id/approve', async (req, res) => {
  const withdrawal = await Withdrawal.findOne({ id: req.params.id });
  if (!withdrawal) return res.status(404).json({ error: 'Withdrawal request not found.' });
  if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'This request has already been processed.' });

  withdrawal.status = 'success';
  withdrawal.adminNote = req.body.note || 'Paid out';
  await withdrawal.save();

  if (withdrawal.transactionId) {
    await Transaction.findOneAndUpdate({ id: withdrawal.transactionId }, { status: 'success' });
  }

  res.json({ message: 'Withdrawal marked as paid.', withdrawal });
});

router.post('/withdrawals/:id/reject', async (req, res) => {
  const withdrawal = await Withdrawal.findOne({ id: req.params.id });
  if (!withdrawal) return res.status(404).json({ error: 'Withdrawal request not found.' });
  if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'This request has already been processed.' });

  // Refund the wallet since the amount was debited when the request was made.
  const user = await User.findOne({ id: withdrawal.userId });
  if (user) {
    user.walletBalance = Number(user.walletBalance) + Number(withdrawal.amount);
    await user.save();
  }

  withdrawal.status = 'failed';
  withdrawal.adminNote = req.body.note || 'Rejected';
  await withdrawal.save();

  if (withdrawal.transactionId) {
    await Transaction.findOneAndUpdate({ id: withdrawal.transactionId }, { status: 'failed' });
  }

  res.json({ message: 'Withdrawal rejected and wallet refunded.', withdrawal });
});

// ---- Airtime to cash ----
router.get('/airtime-to-cash', async (req, res) => {
  const requests = await AirtimeToCash.find().sort({ createdAt: -1 });
  res.json({ requests });
});

router.post('/airtime-to-cash/:id/approve', async (req, res) => {
  const request = await AirtimeToCash.findOne({ id: req.params.id });
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'This request has already been processed.' });

  const user = await User.findOne({ id: request.userId });
  if (!user) return res.status(404).json({ error: 'User not found.' });

  user.walletBalance = Number(user.walletBalance) + Number(request.cashValue);
  await user.save();

  request.status = 'success';
  request.adminNote = req.body.note || 'Verified and credited';
  await request.save();

  if (request.transactionId) {
    await Transaction.findOneAndUpdate({ id: request.transactionId }, { status: 'success' });
  }

  res.json({ message: 'Request approved and wallet credited.', request });
});

router.post('/airtime-to-cash/:id/reject', async (req, res) => {
  const request = await AirtimeToCash.findOne({ id: req.params.id });
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'This request has already been processed.' });

  request.status = 'failed';
  request.adminNote = req.body.note || 'Rejected — airtime not received';
  await request.save();

  if (request.transactionId) {
    await Transaction.findOneAndUpdate({ id: request.transactionId }, { status: 'failed' });
  }

  res.json({ message: 'Request rejected.', request });
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
