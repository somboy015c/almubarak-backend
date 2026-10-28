// Settles a payment made through Flutterwave. Used by BOTH the browser "verify" call
// and the Flutterwave webhook, so a payment is credited exactly once even if both
// arrive at the same moment (or the customer closes the tab after paying).
//
// A payment can be a plain wallet top-up, or a payment for one specific order
// ("pay with Flutterwave" at checkout). For the second kind the wallet is credited
// with the amount paid and the order then runs straight away.

const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Funding = require('../models/Funding');
const Transaction = require('../models/Transaction');
const flutterwave = require('./flutterwave');
const { executePurchase } = require('./orders');
const { logEvent } = require('../utils/log');

// Runs the order attached to a payment, once. Returns a small result object or null.
async function fulfilOrder(funding) {
  if (!funding.order) return null;
  if (funding.orderStatus === 'done') return funding.orderResult;
  if (funding.orderStatus === 'processing') return { state: 'pending', message: 'Your order is being processed.' };

  const claimed = await Funding.findOneAndUpdate(
    { reference: funding.reference, orderStatus: 'queued' },
    { orderStatus: 'processing' },
    { new: true }
  );
  if (!claimed) return null;

  const o = claimed.order;
  const r = await executePurchase({
    userId: claimed.userId,
    kind: o.kind,
    price: o.price,
    description: o.description,
    payload: o.payload,
    via: 'flutterwave'
  });

  const result = {
    state: r.state,
    message: r.state === 'failed'
      ? `${r.body.error || 'The order could not be completed.'} Your payment was added to your wallet balance.`
      : r.body.message,
    reference: r.body.reference || null,
    token: r.body.token || null,
    cards: r.body.cards || null,
    description: o.description,
    amount: o.price
  };
  await Funding.updateOne({ reference: claimed.reference }, { orderStatus: 'done', orderResult: result });
  return result;
}

// Returns { state: 'success' | 'pending' | 'failed' | 'not-found', alreadyCredited?, order? }
async function settleFunding(reference) {
  const funding = await Funding.findOne({ reference });
  if (!funding) return { state: 'not-found' };

  if (funding.status === 'success') {
    // Paid earlier. If its order never finished (e.g. the server restarted), finish it now.
    const order = funding.order ? await fulfilOrder(funding) : null;
    return { state: 'success', alreadyCredited: true, funding, order };
  }

  const result = await flutterwave.verifyFunding(reference, funding.amount);

  if (result.state === 'failed') {
    await Funding.updateOne({ reference, status: { $ne: 'success' } }, { status: 'failed' });
    logEvent({ category: 'payment', level: 'warn', action: 'payment.failed', message: `Payment ${reference} failed or amount did not match`, user: { id: funding.userId }, meta: { reference, amount: funding.amount, flutterwave: result.raw } });
    return { state: 'failed', funding };
  }
  if (result.state !== 'success') return { state: 'pending', funding };

  // Atomically claim the credit: only one caller can flip it to success.
  const claimed = await Funding.findOneAndUpdate(
    { reference, status: { $ne: 'success' } },
    { status: 'success' },
    { new: true }
  );
  if (!claimed) return { state: 'success', alreadyCredited: true, funding, order: funding.order ? await fulfilOrder(await Funding.findOne({ reference })) : null };

  const credited = await User.findOneAndUpdate({ id: claimed.userId }, { $inc: { walletBalance: Number(claimed.amount) } }, { new: true });
  await Transaction.create({
    id: uuidv4(),
    userId: claimed.userId,
    type: 'wallet-funding',
    description: claimed.order ? `Payment for ${claimed.order.description}` : 'Wallet funding',
    amount: Number(claimed.amount),
    status: 'success',
    reference: claimed.reference
  });
  logEvent({ category: 'payment', action: 'payment.success', message: `Payment of ${claimed.amount} confirmed (${reference})`, user: { id: claimed.userId, email: credited?.email }, meta: { reference, amount: claimed.amount, forOrder: !!claimed.order } });

  const order = claimed.order ? await fulfilOrder(claimed) : null;
  return { state: 'success', funding: claimed, order };
}

module.exports = { settleFunding };
