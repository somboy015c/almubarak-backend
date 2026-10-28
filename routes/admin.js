const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Withdrawal = require('../models/Withdrawal');
const AirtimeToCash = require('../models/AirtimeToCash');
const Log = require('../models/Log');
const { getOrCreatePricing, Pricing } = require('../models/Pricing');
const { Settings, getSettings, clearSettingsCache, SERVICES } = require('../models/Settings');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { publicUser, round2 } = require('../utils/helpers');
const { logEvent } = require('../utils/log');
const { frontendUrl } = require('../utils/urls');
const provider = require('../services/arrifqubundle');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const SERVICE_TYPES = ['airtime', 'data', 'electricity', 'cable', 'exam'];
const NETWORKS = ['mtn', 'glo', 'airtel', '9mobile'];
const CABLES = ['dstv', 'gotv', 'startimes'];
const SERVICE_LABELS = {
  airtime: 'Airtime', data: 'Data', electricity: 'Electricity', cable: 'Cable TV', exam: 'Exam PINs',
  funding: 'Wallet funding / pay with Flutterwave', transfer: 'Wallet transfers', withdrawal: 'Withdrawals', 'airtime-to-cash': 'Airtime to cash'
};

const actorOf = (req) => ({ id: req.user.id, email: req.user.email });
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function paging(req, def = 25) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || def, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

function dateRange(req, field = 'createdAt') {
  const out = {};
  if (req.query.from) {
    const d = new Date(req.query.from);
    if (!Number.isNaN(d.getTime())) out.$gte = d;
  }
  if (req.query.to) {
    const d = new Date(req.query.to);
    if (!Number.isNaN(d.getTime())) { d.setHours(23, 59, 59, 999); out.$lte = d; }
  }
  return Object.keys(out).length ? { [field]: out } : {};
}

function csvCell(v) {
  const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}
function sendCsv(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send([header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n'));
}

// ============================================================ Overview ============
router.get('/stats', async (req, res) => {
  const now = Date.now();
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const d7 = new Date(now - 7 * 864e5);
  const d14 = new Date(now - 14 * 864e5);
  const d30 = new Date(now - 30 * 864e5);
  const d1 = new Date(now - 864e5);

  const salesFor = (since) =>
    Transaction.aggregate([
      { $match: { type: { $in: SERVICE_TYPES }, status: 'success', createdAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          sales: { $sum: '$amount' },
          // Profit is only counted for orders where the provider's charge was recorded.
          knownSales: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$meta.providerCost', 0] }, 0] }, '$amount', 0] } },
          knownCost: { $sum: { $ifNull: ['$meta.providerCost', 0] } }
        }
      }
    ]);

  const [
    totalUsers, newUsers7, floatAgg, today, week, month, byService, daily,
    pendingOrders, pendingWithdrawals, pendingA2C, failed24h, totalTransactions
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: d7 } }),
    User.aggregate([{ $group: { _id: null, total: { $sum: '$walletBalance' } } }]),
    salesFor(startToday), salesFor(d7), salesFor(d30),
    Transaction.aggregate([
      { $match: { type: { $in: SERVICE_TYPES }, status: 'success', createdAt: { $gte: d30 } } },
      { $group: { _id: '$type', count: { $sum: 1 }, sales: { $sum: '$amount' } } }
    ]),
    Transaction.aggregate([
      { $match: { type: { $in: SERVICE_TYPES }, status: 'success', createdAt: { $gte: d14 } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Africa/Lagos' } }, count: { $sum: 1 }, sales: { $sum: '$amount' } } },
      { $sort: { _id: 1 } }
    ]),
    Transaction.countDocuments({ status: 'pending', type: { $in: SERVICE_TYPES } }),
    Withdrawal.countDocuments({ status: 'pending' }),
    AirtimeToCash.countDocuments({ status: 'pending' }),
    Transaction.countDocuments({ status: 'failed', type: { $in: SERVICE_TYPES }, createdAt: { $gte: d1 } }),
    Transaction.countDocuments()
  ]);

  const pack = (a) => {
    const r = a[0] || { count: 0, sales: 0, knownSales: 0, knownCost: 0 };
    return { orders: r.count, sales: round2(r.sales), profit: round2(r.knownSales - r.knownCost), profitCoverage: r.sales ? Math.round((r.knownSales / r.sales) * 100) : 100 };
  };

  res.json({
    totalUsers,
    newUsers7d: newUsers7,
    totalTransactions,
    walletFloat: round2(floatAgg[0]?.total || 0),
    today: pack(today), week: pack(week), month: pack(month),
    byService: byService.map((r) => ({ type: r._id, orders: r.count, sales: round2(r.sales) })).sort((a, b) => b.sales - a.sales),
    daily: daily.map((r) => ({ date: r._id, orders: r.count, sales: round2(r.sales) })),
    attention: { pendingOrders, pendingWithdrawals, pendingA2C, failedOrders24h: failed24h }
  });
});

// Live provider wallet balance (the money that actually pays for airtime/data/etc.)
router.get('/provider-balance', async (req, res) => {
  const result = await provider.getBalance();
  const threshold = Number(process.env.PROVIDER_LOW_BALANCE_ALERT || 10000);
  if (!result.ok) {
    return res.status(502).json({ error: result.message || 'Could not fetch the provider balance.' });
  }
  res.json({
    provider: 'Arrifqubundle',
    balance: result.balance,
    mock: !!result.mock,
    threshold,
    low: result.balance < threshold,
    dashboardUrl: 'https://www.arrifqubundle.com/',
    checkedAt: new Date().toISOString()
  });
});

// What the provider actually returns (IDs, plans, balance) with personal data hidden.
router.get('/provider-check', async (req, res) => {
  res.json(await provider.diagnostics());
});

// Is everything configured? (true/false only. Secrets are never shown.)
router.get('/system', async (req, res) => {
  const live = process.env.PROVIDER_MODE === 'live';
  const raw = process.env.FRONTEND_URL || '';
  const api = (process.env.API_PUBLIC_URL || '').replace(/\/+$/, '');
  const checks = [
    { label: 'Mode', value: live ? 'LIVE (real money)' : 'MOCK (nothing real)', ok: live },
    { label: 'Provider API key (ARRIFQU_API_KEY)', value: process.env.ARRIFQU_API_KEY ? 'set' : 'missing', ok: !!process.env.ARRIFQU_API_KEY },
    { label: 'Email (RESEND_API_KEY)', value: process.env.RESEND_API_KEY ? 'set' : 'missing: emails are only printed in the server log', ok: !!process.env.RESEND_API_KEY },
    { label: 'Flutterwave secret key', value: process.env.FLW_SECRET_KEY ? 'set' : 'missing', ok: !!process.env.FLW_SECRET_KEY },
    { label: 'Flutterwave webhook secret hash', value: process.env.FLW_SECRET_HASH ? 'set' : 'missing: payments will not auto-credit', ok: !!process.env.FLW_SECRET_HASH },
    { label: 'JWT secret strength', value: (process.env.JWT_SECRET || '').length >= 32 ? 'ok' : 'too short, use 32+ random characters', ok: (process.env.JWT_SECRET || '').length >= 32 },
    { label: 'Website address used in emails (FRONTEND_URL)', value: frontendUrl() + (/[,\s]/.test(raw.trim()) ? '  (your setting lists several addresses; use only one)' : ''), ok: !/[,\s]/.test(raw.trim()) && /^https:\/\//.test(frontendUrl()) },
    { label: 'Flutterwave webhook URL to paste in Flutterwave', value: api ? `${api}/api/webhooks/flutterwave` : 'set API_PUBLIC_URL first', ok: !!api }
  ];
  res.json({ checks });
});

// ============================================================ Transactions ========
async function transactionFilter(req) {
  const filter = { ...dateRange(req) };
  const { type, status, q } = req.query;
  if (type === 'services') filter.type = { $in: SERVICE_TYPES };
  else if (type) filter.type = type;
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(esc(String(q).trim()), 'i');
    const users = await User.find({ $or: [{ email: rx }, { fullName: rx }, { phone: rx }] }).select('id').limit(200);
    filter.$or = [{ description: rx }, { reference: rx }, { id: String(q).trim() }, { userId: { $in: users.map((u) => u.id) } }];
  }
  return filter;
}

async function withUsers(transactions) {
  const ids = [...new Set(transactions.map((t) => t.userId))];
  const users = await User.find({ id: { $in: ids } }).select('id fullName email phone');
  const map = Object.fromEntries(users.map((u) => [u.id, u]));
  return transactions.map((t) => {
    const o = t.toObject ? t.toObject() : t;
    const u = map[o.userId];
    return { ...o, userName: u ? u.fullName : 'Unknown user', userEmail: u ? u.email : '', userPhone: u ? u.phone : '' };
  });
}

router.get('/transactions', async (req, res) => {
  const { page, limit, skip } = paging(req);
  const filter = await transactionFilter(req);
  const [total, rows] = await Promise.all([
    Transaction.countDocuments(filter),
    Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
  ]);
  res.json({ transactions: await withUsers(rows), total, page, pages: Math.max(Math.ceil(total / limit), 1) });
});

router.get('/transactions.csv', async (req, res) => {
  const filter = await transactionFilter(req);
  const rows = await withUsers(await Transaction.find(filter).sort({ createdAt: -1 }).limit(5000));
  sendCsv(res, 'transactions.csv',
    ['Date', 'Reference', 'Type', 'Description', 'Amount', 'Status', 'Customer', 'Email', 'Provider cost', 'Paid via'],
    rows.map((t) => [new Date(t.createdAt).toISOString(), t.reference, t.type, t.description, t.amount, t.status, t.userName, t.userEmail, t.meta?.providerCost ?? '', t.meta?.via ?? '']));
});

router.get('/transactions/:id', async (req, res) => {
  const tx = await Transaction.findOne({ id: req.params.id });
  if (!tx) return res.status(404).json({ error: 'Transaction not found.' });
  const [row] = await withUsers([tx]);
  res.json({ transaction: row });
});

// Resolve an order that is stuck "pending" and could not be looked up automatically.
router.post('/transactions/:id/resolve', async (req, res) => {
  const { action } = req.body; // 'success' | 'refund'
  const tx = await Transaction.findOne({ id: req.params.id });
  if (!tx) return res.status(404).json({ error: 'Transaction not found.' });
  if (tx.status !== 'pending') return res.status(400).json({ error: 'This transaction is not pending.' });
  if (!SERVICE_TYPES.includes(tx.type)) return res.status(400).json({ error: 'Only service orders can be resolved here.' });

  if (action === 'success') {
    await Transaction.updateOne({ id: tx.id, status: 'pending' }, { status: 'success' });
    logEvent({ category: 'admin', action: 'order.resolve.success', message: `Marked ${tx.reference} as delivered`, actor: actorOf(req), user: { id: tx.userId }, meta: { transaction: tx.id, amount: tx.amount } });
    return res.json({ message: 'Marked as successful.' });
  }
  if (action === 'refund') {
    const flipped = await Transaction.findOneAndUpdate({ id: tx.id, status: 'pending' }, { status: 'failed' });
    if (flipped) await User.updateOne({ id: tx.userId }, { $inc: { walletBalance: Number(tx.amount) } });
    logEvent({ category: 'admin', action: 'order.resolve.refund', message: `Refunded ${tx.reference}`, actor: actorOf(req), user: { id: tx.userId }, meta: { transaction: tx.id, amount: tx.amount } });
    return res.json({ message: 'Marked as failed and the customer was refunded.' });
  }
  res.status(400).json({ error: 'Choose "success" or "refund".' });
});

// ============================================================ Users ===============
router.get('/users', async (req, res) => {
  const { page, limit, skip } = paging(req, 20);
  const filter = {};
  if (req.query.q) {
    const rx = new RegExp(esc(String(req.query.q).trim()), 'i');
    filter.$or = [{ fullName: rx }, { email: rx }, { phone: rx }];
  }
  if (req.query.status === 'suspended') filter.suspended = true;
  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
  ]);
  res.json({ users: users.map(publicUser), total, page, pages: Math.max(Math.ceil(total / limit), 1) });
});

router.get('/users/:id', async (req, res) => {
  const user = await User.findOne({ id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const [recent, orders, spent] = await Promise.all([
    Transaction.find({ userId: user.id }).sort({ createdAt: -1 }).limit(20),
    Transaction.countDocuments({ userId: user.id, type: { $in: SERVICE_TYPES }, status: 'success' }),
    Transaction.aggregate([{ $match: { userId: user.id, type: { $in: SERVICE_TYPES }, status: 'success' } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
  ]);
  res.json({ user: publicUser(user), recent, orders, totalSpent: round2(spent[0]?.total || 0) });
});

// Manually credit or debit a user's wallet (e.g. reversing a failed provider charge)
router.post('/users/:id/wallet-adjust', async (req, res) => {
  const { amount, reason } = req.body;
  const numericAmount = Number(amount);
  if (!numericAmount) return res.status(400).json({ error: 'A non-zero amount is required.' });

  const filter = { id: req.params.id };
  if (numericAmount < 0) filter.walletBalance = { $gte: -numericAmount }; // never push a wallet below zero
  const user = await User.findOneAndUpdate(filter, { $inc: { walletBalance: numericAmount } }, { new: true });
  if (!user) return res.status(numericAmount < 0 ? 400 : 404).json({ error: numericAmount < 0 ? 'User not found or the wallet balance is too low for this debit.' : 'User not found.' });

  await Transaction.create({
    id: uuidv4(),
    userId: req.params.id,
    type: 'admin-adjustment',
    description: reason || 'Manual wallet adjustment by admin',
    amount: numericAmount,
    status: 'success',
    reference: `ADJ-${Date.now()}`
  });
  logEvent({ category: 'admin', level: 'warn', action: 'wallet.adjust', message: `Wallet ${numericAmount > 0 ? 'credited' : 'debited'} ${Math.abs(numericAmount)}: ${reason || 'no reason given'}`, actor: actorOf(req), user: { id: user.id, email: user.email }, meta: { amount: numericAmount, newBalance: user.walletBalance } });

  res.json({ message: 'Wallet updated.', user: publicUser(user) });
});

router.post('/users/:id/suspend', async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot suspend your own account.' });
  const suspended = !!req.body.suspended;
  const user = await User.findOneAndUpdate(
    { id: req.params.id },
    { suspended, suspendedReason: suspended ? String(req.body.reason || '').slice(0, 200) : '' },
    { new: true }
  );
  if (!user) return res.status(404).json({ error: 'User not found.' });
  logEvent({ category: 'admin', level: 'warn', action: suspended ? 'user.suspend' : 'user.unsuspend', message: `${suspended ? 'Suspended' : 'Reactivated'} ${user.email}`, actor: actorOf(req), user: { id: user.id, email: user.email }, meta: { reason: req.body.reason || null } });
  res.json({ message: suspended ? 'Account suspended.' : 'Account reactivated.', user: publicUser(user) });
});

router.post('/users/:id/admin', async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own admin access.' });
  const isAdmin = !!req.body.isAdmin;
  const user = await User.findOneAndUpdate({ id: req.params.id }, { isAdmin }, { new: true });
  if (!user) return res.status(404).json({ error: 'User not found.' });
  logEvent({ category: 'admin', level: 'warn', action: isAdmin ? 'user.make-admin' : 'user.remove-admin', message: `${isAdmin ? 'Granted' : 'Removed'} admin access for ${user.email}`, actor: actorOf(req), user: { id: user.id, email: user.email } });
  res.json({ message: isAdmin ? 'User is now an admin.' : 'Admin access removed.', user: publicUser(user) });
});

// ============================================================ Withdrawals =========
async function enrich(list) {
  const userIds = [...new Set(list.map((w) => w.userId))];
  const users = await User.find({ id: { $in: userIds } });
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  return list.map((w) => {
    const obj = w.toObject();
    const u = userMap[w.userId];
    obj.userName = u ? u.fullName : 'Unknown user';
    obj.userEmail = u ? u.email : '';
    return obj;
  });
}

router.get('/withdrawals', async (req, res) => {
  res.json({ withdrawals: await enrich(await Withdrawal.find().sort({ createdAt: -1 }).limit(300)) });
});

router.post('/withdrawals/:id/approve', async (req, res) => {
  const withdrawal = await Withdrawal.findOneAndUpdate(
    { id: req.params.id, status: 'pending' },
    { status: 'success', adminNote: req.body.note || 'Paid out' },
    { new: true }
  );
  if (!withdrawal) return res.status(400).json({ error: 'Request not found or already processed.' });
  if (withdrawal.transactionId) await Transaction.findOneAndUpdate({ id: withdrawal.transactionId }, { status: 'success' });
  logEvent({ category: 'admin', action: 'withdrawal.approve', message: `Withdrawal of ${withdrawal.amount} marked paid`, actor: actorOf(req), user: { id: withdrawal.userId }, meta: { withdrawal: withdrawal.id } });
  res.json({ message: 'Withdrawal marked as paid.', withdrawal });
});

router.post('/withdrawals/:id/reject', async (req, res) => {
  const withdrawal = await Withdrawal.findOneAndUpdate(
    { id: req.params.id, status: 'pending' },
    { status: 'failed', adminNote: req.body.note || 'Rejected' },
    { new: true }
  );
  if (!withdrawal) return res.status(400).json({ error: 'Request not found or already processed.' });
  await User.updateOne({ id: withdrawal.userId }, { $inc: { walletBalance: Number(withdrawal.amount) } }); // refund
  if (withdrawal.transactionId) await Transaction.findOneAndUpdate({ id: withdrawal.transactionId }, { status: 'failed' });
  logEvent({ category: 'admin', level: 'warn', action: 'withdrawal.reject', message: `Withdrawal of ${withdrawal.amount} rejected and refunded`, actor: actorOf(req), user: { id: withdrawal.userId }, meta: { withdrawal: withdrawal.id, note: req.body.note || null } });
  res.json({ message: 'Withdrawal rejected and wallet refunded.', withdrawal });
});

// ============================================================ Airtime to cash =====
router.get('/airtime-to-cash', async (req, res) => {
  res.json({ requests: await enrich(await AirtimeToCash.find().sort({ createdAt: -1 }).limit(300)) });
});

router.post('/airtime-to-cash/:id/approve', async (req, res) => {
  const request = await AirtimeToCash.findOneAndUpdate(
    { id: req.params.id, status: 'pending' },
    { status: 'success', adminNote: req.body.note || 'Verified and credited' },
    { new: true }
  );
  if (!request) return res.status(400).json({ error: 'Request not found or already processed.' });
  await User.updateOne({ id: request.userId }, { $inc: { walletBalance: Number(request.cashValue) } });
  if (request.transactionId) await Transaction.findOneAndUpdate({ id: request.transactionId }, { status: 'success' });
  logEvent({ category: 'admin', action: 'a2c.approve', message: `Airtime-to-cash of ${request.cashValue} credited`, actor: actorOf(req), user: { id: request.userId }, meta: { request: request.id } });
  res.json({ message: 'Request approved and wallet credited.', request });
});

router.post('/airtime-to-cash/:id/reject', async (req, res) => {
  const request = await AirtimeToCash.findOneAndUpdate(
    { id: req.params.id, status: 'pending' },
    { status: 'failed', adminNote: req.body.note || 'Rejected: airtime not received' },
    { new: true }
  );
  if (!request) return res.status(400).json({ error: 'Request not found or already processed.' });
  if (request.transactionId) await Transaction.findOneAndUpdate({ id: request.transactionId }, { status: 'failed' });
  logEvent({ category: 'admin', action: 'a2c.reject', message: 'Airtime-to-cash request rejected', actor: actorOf(req), user: { id: request.userId }, meta: { request: request.id, note: req.body.note || null } });
  res.json({ message: 'Request rejected.', request });
});

// ============================================================ Pricing =============
router.get('/pricing', async (req, res) => {
  res.json({ pricing: await getOrCreatePricing() });
});

router.put('/pricing', async (req, res) => {
  await getOrCreatePricing();
  const b = req.body || {};
  const set = {};
  const take = (path, value, { min = 0, max = 1000 } = {}) => {
    if (value === undefined) return;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid value for ${path}.`);
    set[path] = n;
  };
  try {
    take('airtime.markupPercent', b.airtime?.markupPercent, { max: 100 });
    take('data.markupPercent', b.data?.markupPercent, { max: 100 });
    take('electricity.markupPercent', b.electricity?.markupPercent, { max: 100 });
    take('cable.markupPercent', b.cable?.markupPercent, { max: 100 });
    take('exam.flatFee', b.exam?.flatFee, { max: 100000 });
    take('airtimeToCash.ratePercent', b.airtimeToCash?.ratePercent, { min: 1, max: 100 });
    take('withdrawal.minAmount', b.withdrawal?.minAmount, { max: 10000000 });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const updated = await Pricing.findByIdAndUpdate('singleton', { $set: set }, { new: true });
  logEvent({ category: 'admin', action: 'pricing.update', message: 'Pricing changed', actor: actorOf(req), meta: set });
  res.json({ pricing: updated });
});

// ============================================================ Services & plans ====
router.get('/service-control', async (req, res) => {
  const s = await getSettings(true);
  const off = (list, v) => !list.includes(v);

  const dataByNetwork = {};
  for (const n of NETWORKS) {
    const plans = await provider.getVariations('data', n);
    const cats = {};
    plans.forEach((p) => { cats[p.category] = (cats[p.category] || 0) + 1; });
    dataByNetwork[n] = {
      categories: Object.entries(cats).map(([name, count]) => ({ name, count, on: off(s.disabledCategories, `${n}|${name}`) })).sort((a, b) => a.name.localeCompare(b.name)),
      plans: plans.map((p) => ({ id: p.variation_code, name: p.name, category: p.category, amount: p.amount, on: off(s.disabledPlans, `data:${p.variation_code}`) }))
    };
  }
  const cables = [];
  for (const c of CABLES) {
    const plans = await provider.getVariations('cable', c);
    cables.push({ key: c, on: off(s.disabledCables, c), plans: plans.map((p) => ({ id: p.variation_code, name: p.name, amount: p.amount, on: off(s.disabledPlans, `cable:${p.variation_code}`) })) });
  }
  const discos = (await provider.getDiscos()).map((d) => ({ id: String(d.id), name: d.name, on: off(s.disabledDiscos, String(d.id)) }));
  const exam = (await provider.getVariations('exam')).map((p) => ({ id: p.variation_code, name: p.name, amount: p.amount, on: off(s.disabledPlans, `exam:${p.variation_code}`) }));

  res.json({
    site: { maintenance: s.maintenance, maintenanceMessage: s.maintenanceMessage, notice: s.notice },
    services: SERVICES.map((key) => ({ key, label: SERVICE_LABELS[key], on: off(s.disabledServices, key) })),
    networks: NETWORKS.map((key) => ({ key, on: off(s.disabledNetworks, key) })),
    cables, discos, exam, data: dataByNetwork
  });
});

const LISTS = {
  service: { field: 'disabledServices', valid: (k) => SERVICES.includes(k) },
  network: { field: 'disabledNetworks', valid: (k) => NETWORKS.includes(k) },
  cable: { field: 'disabledCables', valid: (k) => CABLES.includes(k) },
  disco: { field: 'disabledDiscos', valid: (k) => /^\w+$/.test(k) },
  category: { field: 'disabledCategories', valid: (k) => /^(mtn|glo|airtel|9mobile)\|[A-Z0-9 ]+$/i.test(k) },
  plan: { field: 'disabledPlans', valid: (k) => /^(data|cable|exam):[\w.-]+$/.test(k) }
};

// Turn one thing (or many at once) on or off. type: service | network | cable | disco | category | plan
router.post('/service-control/toggle', async (req, res) => {
  const { type, enabled } = req.body;
  const cfg = LISTS[type];
  if (!cfg) return res.status(400).json({ error: 'Unknown item type.' });
  const keys = (Array.isArray(req.body.keys) ? req.body.keys : [req.body.key]).map(String).filter(Boolean).slice(0, 500);
  if (!keys.length || !keys.every(cfg.valid)) return res.status(400).json({ error: 'Invalid item.' });

  await getSettings();
  await Settings.updateOne({ _id: 'site' }, enabled ? { $pullAll: { [cfg.field]: keys } } : { $addToSet: { [cfg.field]: { $each: keys } } });
  clearSettingsCache();
  logEvent({ category: 'admin', level: 'warn', action: enabled ? 'service.enable' : 'service.disable', message: `${enabled ? 'Turned ON' : 'Turned OFF'} ${type}: ${keys.length > 3 ? `${keys.length} items` : keys.join(', ')}`, actor: actorOf(req), meta: { type, keys: keys.slice(0, 20), enabled: !!enabled } });
  res.json({ message: enabled ? 'Turned on.' : 'Turned off.' });
});

router.put('/site', async (req, res) => {
  await getSettings();
  const set = {};
  if (req.body.maintenance !== undefined) set.maintenance = !!req.body.maintenance;
  if (req.body.maintenanceMessage !== undefined) set.maintenanceMessage = String(req.body.maintenanceMessage).slice(0, 300);
  if (req.body.notice !== undefined) set.notice = String(req.body.notice).slice(0, 300);
  await Settings.updateOne({ _id: 'site' }, { $set: set });
  clearSettingsCache();
  logEvent({ category: 'admin', level: 'warn', action: 'site.update', message: 'Site notice / maintenance settings changed', actor: actorOf(req), meta: set });
  res.json({ message: 'Saved.' });
});

// ============================================================ Logs ================
function logFilter(req) {
  const filter = { ...dateRange(req) };
  if (req.query.category) filter.category = req.query.category;
  if (req.query.level) filter.level = req.query.level;
  if (req.query.q) {
    const rx = new RegExp(esc(String(req.query.q).trim()), 'i');
    filter.$or = [{ message: rx }, { action: rx }, { userEmail: rx }, { actorEmail: rx }];
  }
  return filter;
}

router.get('/logs', async (req, res) => {
  const { page, limit, skip } = paging(req, 50);
  const filter = logFilter(req);
  const [total, logs] = await Promise.all([Log.countDocuments(filter), Log.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)]);
  res.json({ logs, total, page, pages: Math.max(Math.ceil(total / limit), 1) });
});

router.get('/logs.csv', async (req, res) => {
  const logs = await Log.find(logFilter(req)).sort({ createdAt: -1 }).limit(5000);
  sendCsv(res, 'activity-log.csv', ['Time', 'Category', 'Level', 'Action', 'Message', 'Customer', 'Admin', 'IP', 'Details'],
    logs.map((l) => [new Date(l.createdAt).toISOString(), l.category, l.level, l.action, l.message, l.userEmail || l.userId || '', l.actorEmail || '', l.ip || '', l.meta]));
});

module.exports = router;
