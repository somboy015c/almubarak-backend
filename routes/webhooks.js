// Webhooks from Flutterwave. No login here (the providers call us),
// so NOTHING in a webhook body is trusted: we always re-check with the provider.

const express = require('express');
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const Withdrawal = require('../models/Withdrawal');
const User = require('../models/User');
const { settleFunding } = require('../services/funding');
const { logEvent } = require('../utils/log');
const { notifyWithdrawal, alertAdmin } = require('../services/notify');

const router = express.Router();

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- Flutterwave: set URL + secret hash in Flutterwave dashboard -> Settings -> Webhooks ----
router.post('/flutterwave', async (req, res) => {
  if (!process.env.FLW_SECRET_HASH || !safeEqual(req.headers['verif-hash'], process.env.FLW_SECRET_HASH)) {
    logEvent({ category: 'payment', level: 'error', action: 'webhook.rejected', message: 'Flutterwave webhook rejected: secret hash missing or does not match FLW_SECRET_HASH', req });
    alertAdmin({ key: 'webhook-rejected', level: 'critical', title: 'A payment webhook was rejected', message: 'Someone called your Flutterwave webhook with a wrong or missing secret hash. If you just changed the hash, make sure Flutterwave and FLW_SECRET_HASH match. Otherwise this could be someone probing your site.', rows: [['IP address', String(req.ip || '')]], throttleMs: 60 * 60 * 1000 });
    return res.status(401).end();
  }
  res.status(200).end();

  try {
    const event = req.body?.event || req.body?.['event.type'];
    const data = req.body?.data || {};

    if (event === 'charge.completed' && data.tx_ref) {
      logEvent({ category: 'payment', action: 'webhook.charge', message: `Flutterwave webhook: charge ${data.tx_ref}`, meta: { status: data.status, amount: data.amount } });
      await settleFunding(data.tx_ref); // re-verifies with Flutterwave before crediting
    }

    if (event === 'transfer.completed' && data.reference) {
      const w = await Withdrawal.findOne({ payoutRef: data.reference });
      if (!w || w.status !== 'pending') return;
      const status = String(data.status || '').toUpperCase();

      if (status === 'SUCCESSFUL') {
        const flipped = await Withdrawal.findOneAndUpdate({ id: w.id, status: 'pending' }, { status: 'success', adminNote: 'Paid via Flutterwave' });
        if (flipped && w.transactionId) await Transaction.updateOne({ id: w.transactionId }, { status: 'success' });
        if (flipped) {
          const owner = await User.findOne({ id: w.userId });
          if (owner) notifyWithdrawal(owner, { state: 'success', amount: w.amount, bankName: w.bankName, accountNumber: w.accountNumber, accountName: w.accountName, balance: owner.walletBalance });
        }
      } else if (status === 'FAILED') {
        const flipped = await Withdrawal.findOneAndUpdate({ id: w.id, status: 'pending' }, { status: 'failed', adminNote: 'Payout failed at Flutterwave. Wallet refunded.' });
        if (flipped) {
          const owner = await User.findOneAndUpdate({ id: w.userId }, { $inc: { walletBalance: Number(w.amount) } }, { new: true });
          if (w.transactionId) await Transaction.updateOne({ id: w.transactionId }, { status: 'failed' });
          if (owner) notifyWithdrawal(owner, { state: 'failed', amount: w.amount, bankName: w.bankName, accountNumber: w.accountNumber, accountName: w.accountName, balance: owner.walletBalance });
        }
      }
    }
  } catch (err) {
    console.error('Flutterwave webhook error:', err.message);
  }
});

module.exports = router;
