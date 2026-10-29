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
const { notifyOrder, alertAdmin } = require('./notify');

const PROVIDER_ALERTS = {
  FORBIDDEN: ['critical', 'The provider refused this server', 'Arrifqubundle replied "Forbidden". Your account probably has an allowed-IP rule that does not include this server. Add the server\'s outbound IPs in your Arrifqubundle account (or remove the IP lock). Customers cannot buy anything until this is fixed.'],
  AUTH: ['critical', 'The provider rejected the API key', 'Arrifqubundle refused the API key (ARRIFQU_API_KEY). It may have been regenerated or mistyped. Customers cannot buy anything until this is fixed.'],
  LOW_FUNDS: ['critical', 'Your provider wallet may be out of money', 'Arrifqubundle declined an order because of the balance. Top up your Arrifqubundle wallet now, or customer orders will keep failing.'],
  CONFIG: ['critical', 'A service cannot run: setup problem', 'An order could not be built (missing API key or an ID the provider did not list). Check Admin panel > Overview > Provider check.'],
  RATE_LIMIT: ['warning', 'The provider is limiting your orders', 'Arrifqubundle is rejecting orders as "too many requests". Ask them to set your account type to API.'],
  UNREACHABLE: ['warning', 'The provider is not answering', 'Orders are timing out or getting server errors from Arrifqubundle. Affected orders are held as "processing" and will be settled automatically.']
};

function providerAlert(result) {
  const a = result.alertCode && PROVIDER_ALERTS[result.alertCode];
  if (!a) return;
  alertAdmin({
    key: `provider:${result.alertCode}`, level: a[0], title: a[1], message: a[2],
    rows: result.logMessage ? [['Provider said', String(result.logMessage).slice(0, 200)]] : [],
    throttleMs: 30 * 60 * 1000
  });
}

// Five or more failed orders in ten minutes usually means something is broken.
async function failureSpike() {
  try {
    const n = await Transaction.countDocuments({
      type: { $in: ['airtime', 'data', 'electricity', 'cable', 'exam'] },
      status: 'failed',
      createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) }
    });
    if (n >= 5) {
      alertAdmin({
        key: 'failure-spike', level: 'critical', title: `${n} orders failed in the last 10 minutes`,
        message: "Several customer orders are failing. Check the Activity log for the provider's replies, and check your provider balance.",
        rows: [['Failed orders', String(n)]], throttleMs: 60 * 60 * 1000
      });
    }
  } catch (e) { /* alerts must never break an order */ }
}


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
    notifyOrder(fresh, { state: 'failed', kind, description, amount: price, reference: result.request_id, via, balance: fresh.walletBalance });
    providerAlert(result);
    failureSpike();
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
    notifyOrder(fresh, { state: 'pending', kind, description, amount: price, reference: result.request_id, via, balance: fresh.walletBalance });
    providerAlert(result);
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
  notifyOrder(fresh, { state: 'success', kind, description, amount: price, reference: result.request_id, token: result.token, via, balance: fresh.walletBalance });
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
