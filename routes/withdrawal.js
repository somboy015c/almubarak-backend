const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Withdrawal = require('../models/Withdrawal');
const { getOrCreatePricing } = require('../models/Pricing');
const { requireAuth, requirePin } = require('../middleware/auth');
const { generateRef, publicUser } = require('../utils/helpers');
const flutterwave = require('../services/flutterwave');

const router = express.Router();

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

  const refund = async (note) => {
    const flipped = await Withdrawal.findOneAndUpdate({ id: withdrawal.id, status: 'pending' }, { status: 'failed', adminNote: note });
    if (flipped) {
      await User.updateOne({ id: user.id }, { $inc: { walletBalance: numericAmount } });
      await Transaction.updateOne({ id: transaction.id }, { status: 'failed' });
    }
  };

  const transferResult = await flutterwave.initiateTransfer({
    amount: numericAmount,
    bankCode: user.bankAccount.bankCode,
    accountNumber: user.bankAccount.accountNumber,
    accountName: user.bankAccount.accountName,
    reason: `Elmubarak withdrawal ${reference}`
  });

  if (!transferResult.ok) {
    await refund(transferResult.message || 'Payout failed');
    const fresh = await User.findOne({ id: user.id });
    return res.status(502).json({
      error: transferResult.message || 'Withdrawal could not be processed. You have not been charged.',
      user: publicUser(fresh)
    });
  }

  withdrawal.providerRef = transferResult.providerRef;
  withdrawal.payoutRef = transferResult.reference;

  if (transferResult.status === 'success') {
    withdrawal.status = 'success';
    withdrawal.adminNote = 'Paid automatically via Flutterwave';
    await withdrawal.save();
    await Transaction.updateOne({ id: transaction.id }, { status: 'success' });
    return res.json({
      message: 'Withdrawal successful. Funds are on the way to your bank account.',
      user: publicUser(await User.findOne({ id: user.id }))
    });
  }

  // Still processing at Flutterwave: stays pending until their webhook settles it
  // (or an admin approves/rejects it from the admin panel).
  await withdrawal.save();
  return res.json({
    message: 'Withdrawal submitted and is being processed. You will be notified shortly.',
    user: publicUser(await User.findOne({ id: user.id }))
  });
});

module.exports = router;
