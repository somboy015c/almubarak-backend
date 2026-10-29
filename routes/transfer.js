const express = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { requireAuth, requirePin } = require('../middleware/auth');
const { generateRef, publicUser } = require('../utils/helpers');
const { notifyTransfer } = require('../services/notify');

const router = express.Router();

router.post('/', requireAuth, requirePin, async (req, res) => {
  const { recipient, amount } = req.body;
  const numericAmount = Number(amount);

  if (!recipient) {
    return res.status(400).json({ error: "Enter the recipient's email or phone number." });
  }
  if (!numericAmount || numericAmount <= 0) {
    return res.status(400).json({ error: 'Enter a valid amount to send.' });
  }

  const identifier = String(recipient).trim().toLowerCase();
  const recipientUser = await User.findOne({
    $or: [{ email: identifier }, { phone: String(recipient).trim() }]
  });

  if (!recipientUser) {
    return res.status(404).json({ error: 'No Elmubarak account found with that email or phone number.' });
  }
  if (recipientUser.id === req.user.id) {
    return res.status(400).json({ error: "You can't transfer to your own account." });
  }

  const sender = await User.findOne({ id: req.user.id });
  const reference = generateRef('TRF');

  // Both wallet changes happen together or not at all. The debit only succeeds if the
  // balance still covers it, so two simultaneous transfers can never overspend.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const debited = await User.findOneAndUpdate(
        { id: sender.id, walletBalance: { $gte: numericAmount } },
        { $inc: { walletBalance: -numericAmount } },
        { session, new: true }
      );
      if (!debited) {
        const e = new Error('INSUFFICIENT');
        e.code = 'INSUFFICIENT';
        throw e;
      }
      await User.updateOne({ id: recipientUser.id }, { $inc: { walletBalance: numericAmount } }, { session });

      await Transaction.create(
        [
          {
            id: uuidv4(),
            userId: sender.id,
            type: 'transfer-out',
            description: `Transfer to ${recipientUser.fullName}`,
            amount: numericAmount,
            status: 'success',
            reference,
            meta: { recipientId: recipientUser.id }
          },
          {
            id: uuidv4(),
            userId: recipientUser.id,
            type: 'transfer-in',
            description: `Transfer from ${sender.fullName}`,
            amount: numericAmount,
            status: 'success',
            reference,
            meta: { senderId: sender.id }
          }
        ],
        { session }
      );
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT') return res.status(402).json({ error: 'Insufficient wallet balance.' });
    console.error('Transfer failed:', err);
    return res.status(500).json({ error: 'The transfer could not be completed. Please try again.' });
  } finally {
    session.endSession();
  }

  const [senderNow, recipientNow] = await Promise.all([User.findOne({ id: sender.id }), User.findOne({ id: recipientUser.id })]);
  notifyTransfer(senderNow, { direction: 'out', amount: numericAmount, counterparty: recipientUser.fullName, reference, balance: senderNow.walletBalance });
  notifyTransfer(recipientNow, { direction: 'in', amount: numericAmount, counterparty: sender.fullName, reference, balance: recipientNow.walletBalance });

  res.json({ message: `₦${numericAmount.toLocaleString()} sent to ${recipientUser.fullName}.`, user: publicUser(senderNow) });
});

module.exports = router;
