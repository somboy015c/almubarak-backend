const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  amount: { type: Number, required: true },
  bankName: String,
  accountNumber: String,
  accountName: String,
  // pending -> awaiting admin payout; success -> admin confirmed paid;
  // failed -> admin rejected (wallet already refunded when this happens)
  status: { type: String, default: 'pending' },
  transactionId: String, // links to the matching Transaction record
  adminNote: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
