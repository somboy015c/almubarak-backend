const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Withdrawal = require('../models/Withdrawal');
const { getOrCreatePricing } = require('../models/Pricing');
const { requireAuth, requirePin } = require('../middleware/auth');
const { generateRef, publicUser } = require('../utils/helpers');

const router = express.Router();

router.post('/', requireAuth, requirePin, async (req, res) => {
  const { amount } = req.body;
  const numericAmount = Number(amount);
  const user = await User.findOne({ id: req.user.id });

  if (!user.bankAccount || !user.bankAccount.accountNumber) {
    return res.status(400).json({ error: 'Please add a withdrawal bank account in Settings first.' });
  }

  const pricing = await getOrCreatePricing();
  const minAmount = pricing.withdrawal.minAmount;
  if (!numericAmount || numericAmount < minAmount) {
    return res.status(400).json({ error: `Minimum withdrawal is ₦${minAmount.toLocaleString()}.` });
  }
  if (Number(user.walletBalance) < numericAmount) {
    return res.status(402).json({ error: 'Insufficient wallet balance.' });
  }

  // Debit immediately so the money is set aside; refunded automatically if
  // an admin rejects the request during manual payout verification.
  user.walletBalance = Number(user.walletBalance) - numericAmount;
  await user.save();

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

  await Withdrawal.create({
    id: uuidv4(),
    userId: user.id,
    amount: numericAmount,
    bankName: user.bankAccount.bankName,
    accountNumber: user.bankAccount.accountNumber,
    accountName: user.bankAccount.accountName,
    status: 'pending',
    transactionId: transaction.id
  });

  res.json({
    message: 'Withdrawal request submitted. It will be paid out once reviewed.',
    user: publicUser(user)
  });
});

module.exports = router;
