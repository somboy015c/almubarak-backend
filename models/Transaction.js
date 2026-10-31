const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  type: { type: String, required: true },
  description: String,
  amount: Number,
  status: { type: String, default: 'pending' },
  reference: String,
  // PINs and tokens (exam PINs, electricity tokens) are kept here so customers can find them again in their history.
  token: { type: String, default: null },
  cards: { type: mongoose.Schema.Types.Mixed, default: null },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', transactionSchema);
