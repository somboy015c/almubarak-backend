const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Withdrawal = require('../models/Withdrawal');
const { getOrCreatePricing } = require('../models/Pricing');
const { requireAuth, requirePin } = require('../middleware/auth');
const { generateRef, publicUser } = require('../utils/helpers');
const paystack = require('../services/paystack');

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
  // the payout fails or an admin rejects it.
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

  // ---- Attempt automatic payout via Paystack Transfers ----
  try {
    // Reuse a saved recipient code if we made one before, otherwise create it now.
    let recipientCode = user.bankAccount.recipientCode;
    if (!recipientCode) {
      const recipientResult = await paystack.createTransferRecipient({
        name: user.bankAccount.accountName,
        accountNumber: user.bankAccount.accountNumber,
        bankCode: user.bankAccount.bankCode
      });
      if (!recipientResult.ok) {
        throw new Error(recipientResult.message || 'Could not register this bank account for payout.');
      }
      recipientCode = recipientResult.recipientCode;
      user.bankAccount.recipientCode = recipientCode;
      await user.save();
    }

    const transferResult = await paystack.initiateTransfer({
      amount: numericAmount,
      recipientCode,
      reason: `Almubarak withdrawal ${reference}`
    });

    if (!transferResult.ok) {
      throw new Error(transferResult.message || 'Payout could not be sent.');
    }

    withdrawal.providerRef = transferResult.providerRef;

    if (transferResult.status === 'success') {
      withdrawal.status = 'success';
      withdrawal.adminNote = 'Paid automatically via Paystack';
      await withdrawal.save();
      transaction.status = 'success';
      await transaction.save();
      return res.json({
        message: 'Withdrawal successful — funds are on the way to your bank account.',
        user: publicUser(user)
      });
    }

    // Paystack sometimes holds transfers as 'pending' until approved in
    // the dashboard (e.g. OTP-protected accounts) — leave it queued so
    // either the automatic flow completes later or an admin can step in.
    await withdrawal.save();
    return res.json({
      message: 'Withdrawal submitted and is being processed. You will be credited or notified shortly.',
      user: publicUser(user)
    });
  } catch (err) {
    // Automatic payout failed — refund the wallet and let an admin see it.
    user.walletBalance = Number(user.walletBalance) + numericAmount;
    await user.save();

    withdrawal.status = 'failed';
    withdrawal.adminNote = err.message;
    await withdrawal.save();
    transaction.status = 'failed';
    await transaction.save();

    return res.status(502).json({ error: err.message || 'Withdrawal could not be processed. You have not been charged.' });
  }
});

module.exports = router;
