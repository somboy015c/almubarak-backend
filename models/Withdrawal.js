const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  amount: { type: Number, required: true },
  bankName: String,
  bankCode: String,
  accountNumber: String,
  accountName: String,
  // pending -> awaiting payout (automatic attempt in progress, or stuck
  // pending Paystack OTP approval, or awaiting manual admin action);
  // success -> paid out; failed -> rejected/refunded
  status: { type: String, default: 'pending' },
  providerRef: String, // Paystack transfer_code, when paid automatically
  transactionId: String, // links to the matching Transaction record
  adminNote: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
