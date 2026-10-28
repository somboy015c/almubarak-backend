const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, index: true },
  phone: { type: String, required: true },
  password: { type: String, required: true },
  walletBalance: { type: Number, default: 0 },
  isAdmin: { type: Boolean, default: false },
  suspended: { type: Boolean, default: false },
  suspendedReason: { type: String, default: '' },
  lastLoginAt: { type: Date, default: null },

  // Email verification. Deliberately NO schema default: accounts created
  // before this feature have the field undefined and are treated as already
  // verified. Only accounts explicitly set to false are blocked from login.
  emailVerified: { type: Boolean },
  verifyTokenHash: { type: String, default: null },
  verifyTokenExpires: { type: Date, default: null },
  verifyEmailSentAt: { type: Date, default: null },

  // Password reset (single-use, short-lived; only the SHA-256 hash is stored)
  resetTokenHash: { type: String, default: null },
  resetTokenExpires: { type: Date, default: null },
  resetEmailSentAt: { type: Date, default: null },

  // Hashed 4-digit PIN required to authorize transfers, withdrawals, and
  // airtime-to-cash requests. Null until the user sets one.
  transactionPin: { type: String, default: null },

  // Where withdrawals get paid out to. Set once via Settings before a
  // withdrawal can be requested.
  bankAccount: {
    bankName: { type: String, default: null },
    bankCode: { type: String, default: null },
    accountNumber: { type: String, default: null },
    accountName: { type: String, default: null },
    // Legacy field (Paystack recipient id). Unused with Flutterwave; kept so old records load.
    recipientCode: { type: String, default: null }
  },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
