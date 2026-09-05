const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { publicUser } = require('../utils/helpers');

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/stats', (req, res) => {
  const users = db.get('users').value();
  const transactions = db.get('transactions').value();
  const successful = transactions.filter((t) => t.status === 'success');

  res.json({
    totalUsers: users.length,
    totalTransactions: transactions.length,
    totalRevenue: successful.reduce((sum, t) => sum + Number(t.amount), 0),
    totalWalletFloat: users.reduce((sum, u) => sum + Number(u.walletBalance), 0)
  });
});

router.get('/users', (req, res) => {
  const users = db.get('users').value().map(publicUser);
  res.json({ users });
});

router.get('/transactions', (req, res) => {
  const transactions = db.get('transactions').orderBy(['createdAt'], ['desc']).value();
  res.json({ transactions });
});

// Manually credit or debit a user's wallet (e.g. reversing a failed provider charge)
router.post('/users/:id/wallet-adjust', (req, res) => {
  const { amount, reason } = req.body;
  const numericAmount = Number(amount);
  if (!numericAmount) return res.status(400).json({ error: 'A non-zero amount is required.' });

  const user = db.get('users').find({ id: req.params.id });
  if (!user.value()) return res.status(404).json({ error: 'User not found.' });

  const newBalance = Number(user.value().walletBalance) + numericAmount;
  user.assign({ walletBalance: newBalance }).write();

  db.get('transactions')
    .push({
      id: uuidv4(),
      userId: req.params.id,
      type: 'admin-adjustment',
      description: reason || 'Manual wallet adjustment by admin',
      amount: numericAmount,
      status: 'success',
      reference: `ADJ-${Date.now()}`,
      createdAt: new Date().toISOString()
    })
    .write();

  res.json({ message: 'Wallet updated.', user: publicUser(user.value()) });
});

// Update markup/pricing
router.put('/pricing', (req, res) => {
  db.set('pricing', req.body).write();
  res.json({ pricing: db.get('pricing').value() });
});

router.get('/pricing', (req, res) => {
  res.json({ pricing: db.get('pricing').value() });
});

module.exports = router;
