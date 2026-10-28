const mongoose = require('mongoose');

const fundingSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  reference: { type: String, required: true, unique: true },
  amount: Number,
  status: { type: String, default: 'pending' },
  // Set when the customer chose "pay with Flutterwave" for a specific order
  // instead of paying from their wallet. The order runs once the payment clears.
  order: { type: mongoose.Schema.Types.Mixed, default: null },
  orderStatus: { type: String, default: 'none' }, // none | queued | processing | done
  orderResult: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Funding', fundingSchema);
