// Runs one purchase from start to finish: take the money from the wallet, ask the
// provider, then record success / pending / failed (refunding on failure).
// Used both for "pay from wallet" and for "pay with Flutterwave" orders (which
// run after the payment has been confirmed and credited).

const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Funding = require('../models/Funding');
const provider = require('./arrifqubundle');
const flutterwave = require('./flutterwave');
const { publicUser, round2 } = require('../utils/helpers');
const { logEvent } = require('../utils/log');

async function executePurchase({ userId, kind, price, description, payload, via = 'wallet' }) {
  price = round2(price);
  if (!price || price <= 0) return { status: 400, state: 'failed', body: { error: 'Invalid amount.' } };

  // Atomic debit: succeeds only if the balance still covers the price. Two
  // simultaneous requests can never spend the same money twice.
  const debited = await User.findOneAndUpdate(
    { id: userId, walletBalance: { $gte: price } },
    { $inc: { walletBalance: -price } },
    { new: true }
  );
  if (!debited) {
    return {
      status: 402,
      state: 'failed',
      body: { error: 'Insufficient wallet balance. Please fund your wallet.', code: 'INSUFFICIENT_BALANCE' }
    };
  }

  const result = await provider.purchase(kind, payload);

  const record = (status, extraMeta = {}) =>
    Transaction.create({
      id: uuidv4(),
      userId,
      type: kind,
      description,
      amount: price,
      status,
      reference: result.request_id,
      meta: { ...payload, via, providerId: result.providerId || null, providerCost: result.providerCost ?? null, ...extraMeta }
    });

  const logBase = {
    category: 'order',
    user: { id: userId, email: debited.email },
    meta: {
      kind, via, price, description, reference: result.request_id,
      providerId: result.providerId || null, providerCost: result.providerCost ?? null,
      detail: result.logMessage || null, providerResponse: result.raw || null
    }
  };

  if (result.state === 'failed') {
    await User.updateOne({ id: userId }, { $inc: { walletBalance: price } }); // refund
    await record('failed');
    logEvent({ ...logBase, level: 'warn', action: 'order.failed', message: `${kind} order failed: ${description}` });
    const fresh = await User.findOne({ id: userId });
    return {
      status: 422,
      state: 'failed',
      body: { error: result.message || 'Transaction failed. You have not been charged.', user: publicUser(fresh) }
    };
  }

  if (result.state === 'pending') {
    // Outcome not confirmed yet: keep the money held, settle later.
    await record('pending');
    logEvent({ ...logBase, level: 'warn', action: 'order.pending', message: `${kind} order is processing: ${description}` });
    const fresh = await User.findOne({ id: userId });
    return {
      status: 202,
      state: 'pending',
      body: {
        pending: true,
        message: 'Your order is being processed. You will see the final status in Transactions shortly.',
        reference: result.request_id,
        user: publicUser(fresh)
      }
    };
  }

  await record('success', { token: result.token || null, cards: result.cards || null });
  logEvent({ ...logBase, level: 'info', action: 'order.success', message: `${kind} order successful: ${description}` });
  const fresh = await User.findOne({ id: userId });
  return {
    status: 200,
    state: 'success',
    body: {
      message: result.message || 'Transaction successful',
      reference: result.request_id,
      token: result.token || null,
      cards: result.cards || null,
      user: publicUser(fresh)
    }
  };
}

// "Pay with Flutterwave" for one order. The order is stored with the payment and
// runs automatically once Flutterwave confirms the money (see services/funding.js).
async function startDirectPayment({ user, order }) {
  const init = await flutterwave.initializeFunding({
    email: user.email,
    amount: order.price,
    name: user.fullName,
    phone: user.phone
  });
  if (!init.ok) {
    return { status: 502, body: { error: init.message || 'Could not start payment. Please try again.' } };
  }

  await Funding.create({
    id: uuidv4(),
    userId: user.id,
    reference: init.reference,
    amount: order.price,
    status: 'pending',
    order,
    orderStatus: 'queued'
  });

  logEvent({
    category: 'payment',
    action: 'payment.started',
    message: `Checkout started for ${order.description}`,
    user: { id: user.id, email: user.email },
    meta: { reference: init.reference, amount: order.price, kind: order.kind }
  });

  return {
    status: 200,
    body: { checkout: true, reference: init.reference, authorization_url: init.authorization_url, mock: !!init.mock }
  };
}

module.exports = { executePurchase, startDirectPayment };
