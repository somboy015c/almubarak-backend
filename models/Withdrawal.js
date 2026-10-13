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
  // still processing at Flutterwave, or awaiting manual admin action);
  // success -> paid out; failed -> rejected/refunded
  status: { type: String, default: 'pending' },
  providerRef: String, // Flutterwave transfer id, when paid automatically
  payoutRef: { type: String, index: true }, // our reference sent to Flutterwave (matches webhook)
  transactionId: String, // links to the matching Transaction record
  adminNote: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
