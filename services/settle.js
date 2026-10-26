// Settles service purchases (airtime/data/electricity/cable) that the provider
// reported as "pending". Runs from a background timer and when a customer opens
// their transaction list. The wallet is only refunded when the provider confirms
// the order failed.

const Transaction = require('../models/Transaction');
const User = require('../models/User');
const provider = require('./arrifqubundle');

const SERVICE_TYPES = ['airtime', 'data', 'electricity', 'cable', 'exam'];

async function settlePendingTransaction(tx) {
  if (!tx || tx.status !== 'pending' || !SERVICE_TYPES.includes(tx.type)) return tx;

  // Prefer the provider's order id. Data orders also carry our own customer_ref, so
  // a timed-out data order can still be found. Others are resolved by an admin.
  let providerId = tx.meta && tx.meta.providerId;
  let r;
  if (providerId) {
    r = await provider.requery(tx.type, providerId);
  } else if (tx.type === 'data' && tx.reference) {
    r = await provider.findByRef('data', tx.reference);
  } else {
    return tx;
  }
  if (r.state === 'pending') return tx;

  if (r.state === 'success') {
    const updated = await Transaction.findOneAndUpdate(
      { id: tx.id, status: 'pending' },
      { status: 'success', meta: { ...(tx.meta || {}), providerId: r.providerId || providerId || null, providerCost: r.providerCost ?? null, token: r.token || (tx.meta && tx.meta.token) || null } },
      { new: true }
    );
    return updated || tx;
  }

  // Definite failure: flip status first (only one caller wins), then refund once.
  const failed = await Transaction.findOneAndUpdate({ id: tx.id, status: 'pending' }, { status: 'failed' }, { new: true });
  if (failed) {
    await User.updateOne({ id: tx.userId }, { $inc: { walletBalance: Number(tx.amount) } });
    return failed;
  }
  return tx;
}

// Background sweep: settle recent pending orders that have a provider id.
async function settleAllPending() {
  const cutoff = new Date(Date.now() - 30 * 1000);
  const oldest = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const list = await Transaction.find({
    status: 'pending',
    type: { $in: SERVICE_TYPES },
    $or: [{ 'meta.providerId': { $exists: true, $ne: null } }, { type: 'data' }],
    createdAt: { $lt: cutoff, $gt: oldest }
  })
    .sort({ createdAt: 1 })
    .limit(25);
  for (const tx of list) {
    try {
      await settlePendingTransaction(tx);
    } catch (err) {
      console.error('Settle error:', err.message);
    }
  }
}

module.exports = { settlePendingTransaction, settleAllPending, SERVICE_TYPES };
