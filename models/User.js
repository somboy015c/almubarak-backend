const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, index: true },
  phone: { type: String, required: true },
  password: { type: String, required: true },
  walletBalance: { type: Number, default: 0 },
  isAdmin: { type: Boolean, default: false },

  // Hashed 4-digit PIN required to authorize transfers, withdrawals, and
  // airtime-to-cash requests. Null until the user sets one.
  transactionPin: { type: String, default: null },

  // Where withdrawals get paid out to. Set once via Settings before a
  // withdrawal can be requested.
  bankAccount: {
    bankName: { type: String, default: null },
    accountNumber: { type: String, default: null },
    accountName: { type: String, default: null }
  },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
