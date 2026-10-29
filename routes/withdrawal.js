// Withdrawals are MANUAL. The customer asks, the money is taken from their wallet and held,
// an admin sends the transfer by hand and then marks it paid (or rejects it, which refunds).
// Every step emails the customer and the admins.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Withdrawal = require('../models/Withdrawal');
const { getOrCreatePricing } = require('../models/Pricing');
const { requireAuth, requirePin } = require('../middleware/auth');
const { generateRef, publicUser } = require('../utils/helpers');
const { frontendUrl } = require('../utils/urls');
const { logEvent } = require('../utils/log');
const { notifyWithdrawal, alertAdmin, money } = require('../services/notify');

const router = express.Router();

// The customer's own withdrawal requests and where each one stands.
router.get('/', requireAuth, async (req, res) => {
  const list = await Withdrawal.find({ userId: req.user.id });
  res.json({
    withdrawals: list
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 30)
      .map((w) => ({
        id: w.id, amount: w.amount, status: w.status, bankName: w.bankName, accountNumber: w.accountNumber,
        accountName: w.accountName, note: w.adminNote || '', createdAt: w.createdAt, updatedAt: w.updatedAt
      }))
  });
});

router.post('/', requireAuth, requirePin, async (req, res) => {
  const numericAmount = Number(req.body.amount);
  const user = await User.findOne({ id: req.user.id });

  if (!user.bankAccount || !user.bankAccount.accountNumber) {
    return res.status(400).json({ error: 'Please add a withdrawal bank account in Settings first.' });
  }

  const pricing = await getOrCreatePricing();
  const minAmount = pricing.withdrawal.minAmount;
  if (!numericAmount || numericAmount < minAmount) {
    return res.status(400).json({ error: `Minimum withdrawal is ₦${minAmount.toLocaleString()}.` });
  }

  // Atomic debit: only succeeds if the balance still covers the amount, so two
  // simultaneous requests can never spend the same money twice.
  const debited = await User.findOneAndUpdate(
    { id: user.id, walletBalance: { $gte: numericAmount } },
    { $inc: { walletBalance: -numericAmount } },
    { new: true }
  );
  if (!debited) {
    return res.status(402).json({ error: 'Insufficient wallet balance.' });
  }

  const reference = generateRef('WTH');
  const transaction = await Transaction.create({
    id: uuidv4(),
    userId: user.id,
    type: 'withdrawal',
    description: `Withdrawal to ${user.bankAccount.bankName} - ${user.bankAccount.accountNumber}`,
    amount: numericAmount,
    status: 'pending',
    reference
  });

  const withdrawal = await Withdrawal.create({
    id: uuidv4(),
    userId: user.id,
    amount: numericAmount,
    bankName: user.bankAccount.bankName,
    bankCode: user.bankAccount.bankCode,
    accountNumber: user.bankAccount.accountNumber,
    accountName: user.bankAccount.accountName,
    status: 'pending',
    transactionId: transaction.id
  });

  logEvent({
    category: 'payment', action: 'withdrawal.requested',
    message: `Withdrawal of ${numericAmount} requested`, user: { id: user.id, email: user.email },
    meta: { withdrawal: withdrawal.id, reference, bank: user.bankAccount.bankName }
  });

  // Tell the customer, and tell the admins exactly where to send the money.
  const bank = { bankName: user.bankAccount.bankName, accountNumber: user.bankAccount.accountNumber, accountName: user.bankAccount.accountName };
  notifyWithdrawal(debited, { state: 'requested', amount: numericAmount, ...bank, balance: debited.walletBalance });
  alertAdmin({
    level: 'warning',
    title: `Withdrawal to pay: ${money(numericAmount)}`,
    message: `${user.fullName} asked to withdraw ${money(numericAmount)}. The money is already taken from their wallet. Send it to the account below, then mark it as paid in Admin > Withdrawals so the customer is told.`,
    rows: [
      ['Customer', `${user.fullName} (${user.email})`],
      ['Amount to send', money(numericAmount)],
      ['Bank', bank.bankName], ['Account number', bank.accountNumber], ['Account name', bank.accountName],
      ['Reference', reference]
    ],
    button: { text: 'Open withdrawals', url: `${frontendUrl()}/admin.html#withdrawals` }
  });

  res.json({
    message: 'Withdrawal request received. We will send the money to your bank account and update the status here. You will get an email at each step.',
    user: publicUser(debited)
  });
});

module.exports = router;
