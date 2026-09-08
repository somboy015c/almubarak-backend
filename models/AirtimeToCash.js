const mongoose = require('mongoose');

const airtimeToCashSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  network: { type: String, required: true },
  amountSent: { type: Number, required: true }, // face value the user claims to have sent
  cashValue: { type: Number, required: true },  // what they'll be credited if approved
  phoneUsed: { type: String, required: true },  // the line the airtime was sent from
  // pending -> awaiting admin verification; success -> verified & credited;
  // failed -> admin rejected (nothing credited)
  status: { type: String, default: 'pending' },
  transactionId: String,
  adminNote: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AirtimeToCash', airtimeToCashSchema);
