const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  amount: { type: Number, required: true },
  bankName: String,
  bankCode: String,
  accountNumber: String,
  accountName: String,
  // Withdrawals are paid MANUALLY by an admin:
  // pending    -> the customer asked, the admin has not started yet
  // processing -> the admin is sending the money
  // success    -> paid out;  failed -> rejected (wallet refunded)
  status: { type: String, default: 'pending' },
  providerRef: String, // legacy (automatic payouts are no longer used)
  payoutRef: { type: String, index: true }, // legacy
  transactionId: String, // links to the matching Transaction record
  adminNote: String, // payment reference / reason shown to the customer
  processedBy: { id: String, email: String },
  updatedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
