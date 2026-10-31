// Settles service purchases (airtime/data/electricity/cable) that the provider
// reported as "pending". Runs from a background timer and when a customer opens
// their transaction list. The wallet is only refunded when the provider confirms
// the order failed.

const Transaction = require('../models/Transaction');
const User = require('../models/User');
const provider = require('./arrifqubundle');
const { notifyOrder, alertAdmin } = require('./notify');

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
      { status: 'success', token: r.token || tx.token || (tx.meta && tx.meta.token) || null, cards: r.cards || tx.cards || null, meta: { ...(tx.meta || {}), providerId: r.providerId || providerId || null, providerCost: r.providerCost ?? null, token: r.token || (tx.meta && tx.meta.token) || null } },
      { new: true }
    );
    if (updated) {
      const owner = await User.findOne({ id: tx.userId });
      if (owner) notifyOrder(owner, { state: 'success', kind: tx.type, description: tx.description, amount: tx.amount, reference: tx.reference, token: r.token || (tx.meta && tx.meta.token), via: tx.meta && tx.meta.via, balance: owner.walletBalance });
    }
    return updated || tx;
  }

  // Definite failure: flip status first (only one caller wins), then refund once.
  const failed = await Transaction.findOneAndUpdate({ id: tx.id, status: 'pending' }, { status: 'failed' }, { new: true });
  if (failed) {
    const owner = await User.findOneAndUpdate({ id: tx.userId }, { $inc: { walletBalance: Number(tx.amount) } }, { new: true });
    if (owner) notifyOrder(owner, { state: 'failed', kind: tx.type, description: tx.description, amount: tx.amount, reference: tx.reference, via: tx.meta && tx.meta.via, balance: owner.walletBalance });
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
  // Orders stuck "processing" for 30+ minutes need a human to check the provider.
  const stuck = await Transaction.countDocuments({ status: 'pending', type: { $in: SERVICE_TYPES }, createdAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) } });
  if (stuck > 0) {
    alertAdmin({
      key: 'stuck-orders', level: 'warning',
      title: `${stuck} order${stuck === 1 ? ' is' : 's are'} stuck on "processing"`,
      message: 'These orders have been processing for over 30 minutes and could not be settled automatically. Check each one in your provider dashboard, then use Mark paid or Refund in Admin > Transactions.',
      rows: [['Stuck orders', String(stuck)]], throttleMs: 2 * 60 * 60 * 1000
    });
  }
}

module.exports = { settlePendingTransaction, settleAllPending, SERVICE_TYPES };
