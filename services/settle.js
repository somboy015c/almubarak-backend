// Settles service purchases (airtime/data/electricity/cable/exam) that VTpass
// reported as "pending". Called by the VTpass webhook and when a customer opens
// their transaction list. The wallet is only refunded when VTpass confirms failure.

const Transaction = require('../models/Transaction');
const User = require('../models/User');
const vtpass = require('./vtpass');

const SERVICE_TYPES = ['airtime', 'data', 'electricity', 'cable', 'exam'];

async function settlePendingTransaction(tx) {
  if (!tx || tx.status !== 'pending' || !SERVICE_TYPES.includes(tx.type) || !tx.reference) return tx;

  const r = await vtpass.requery(tx.reference);
  if (r.state === 'pending') return tx;

  if (r.state === 'success') {
    const updated = await Transaction.findOneAndUpdate(
      { id: tx.id, status: 'pending' },
      { status: 'success', meta: { ...(tx.meta || {}), token: r.token || null, cards: r.cards || null } },
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

module.exports = { settlePendingTransaction, SERVICE_TYPES };
