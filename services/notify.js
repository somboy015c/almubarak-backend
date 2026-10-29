// Who gets told what. Customers get an email for every order, payment, withdrawal,
// transfer and login. Admins get security alerts and "something needs you" emails.
//
// Every function here is "fire and forget": it never throws and never slows a
// purchase down. The admin panel (Services & plans > Site) can switch each group off.

const User = require('../models/User');
const { getSettings } = require('../models/Settings');
const { sendBranded } = require('./email');
const { frontendUrl } = require('../utils/urls');
const { logEvent } = require('../utils/log');

const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const when = (d = new Date()) => `${new Date(d).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' })} (Nigeria time)`;
const firstName = (u) => (u.fullName || '').split(' ')[0] || 'there';
const KIND = { airtime: 'Airtime', data: 'Data', electricity: 'Electricity', cable: 'Cable TV', exam: 'Exam PIN' };
const dashboard = () => ({ text: 'Open my dashboard', url: `${frontendUrl()}/dashboard.html` });

function safe(fn) {
  return (...args) => {
    Promise.resolve()
      .then(() => fn(...args))
      .catch((err) => console.error('Notification error:', err.message));
  };
}

async function send(user, flag, opts) {
  const s = await getSettings();
  if (flag && s[flag] === false) return;
  const r = await sendBranded({ to: user.email, ...opts });
  if (r && r.ok === false && !r.skipped) {
    logEvent({ category: 'system', level: 'error', action: 'email.failed', message: `Email "${opts.subject}" could not be sent to ${user.email}`, user: { id: user.id, email: user.email } });
  }
}

// ---------------------------------------------------------------- orders
// o: { state: success|failed|pending, kind, description, amount, reference, token, cards, via, balance }
const notifyOrder = safe(async (user, o) => {
  const label = KIND[o.kind] || 'Order';
  const viaCard = o.via === 'flutterwave';
  const rows = [
    ['Service', label],
    ['Details', o.description],
    ['Amount', money(o.amount)],
    ['Paid with', viaCard ? 'Card / bank transfer (Flutterwave)' : 'Wallet'],
    ['Reference', o.reference],
    ['Date', when()],
    ['Wallet balance', o.balance !== undefined ? money(o.balance) : '']
  ];

  if (o.state === 'success') {
    await send(user, 'emailOrders', {
      subject: `${label} order successful: ${money(o.amount)}`,
      tone: 'success',
      title: `Your ${label.toLowerCase()} order was successful`,
      intro: `Hi ${firstName(user)}, thank you for using ${'Elmubarak Digital Hub'}. Your order has been completed.`,
      token: o.token ? { label: o.kind === 'electricity' ? 'Your electricity token' : 'Your PIN', value: o.token } : null,
      rows,
      button: dashboard()
    });
  } else if (o.state === 'pending') {
    await send(user, 'emailOrders', {
      subject: `We are processing your ${label.toLowerCase()} order`,
      tone: 'pending',
      title: 'We are processing your order',
      intro: `Hi ${firstName(user)}, we received your order and it is being processed. Your money is held safely, and we will email you again as soon as it is final.`,
      rows,
      button: dashboard()
    });
  } else {
    await send(user, 'emailOrders', {
      subject: `${label} order failed: ${money(o.amount)}`,
      tone: 'failed',
      title: 'We could not complete your order',
      intro: viaCard
        ? `Hi ${firstName(user)}, your payment was received but we could not complete this order. The ${money(o.amount)} has been added to your wallet balance, so you can try again from your wallet.`
        : `Hi ${firstName(user)}, we could not complete this order. You have not lost any money: the ${money(o.amount)} has been returned to your wallet.`,
      rows,
      button: dashboard(),
      notes: ['If you keep seeing this, please contact us on WhatsApp and quote the reference above.']
    });
  }
});

// ---------------------------------------------------------------- wallet funding (plain top-ups)
const notifyPayment = safe(async (user, p) => {
  const rows = [['Amount', money(p.amount)], ['Reference', p.reference], ['Date', when()], ['Wallet balance', p.balance !== undefined ? money(p.balance) : '']];
  if (p.state === 'success') {
    await send(user, 'emailOrders', {
      subject: `Wallet funded: ${money(p.amount)}`,
      tone: 'success',
      title: 'Your wallet has been funded',
      intro: `Hi ${firstName(user)}, your payment was received and ${money(p.amount)} has been added to your wallet.`,
      rows,
      button: dashboard()
    });
  } else {
    await send(user, 'emailOrders', {
      subject: 'Your payment was not completed',
      tone: 'failed',
      title: 'Payment not completed',
      intro: `Hi ${firstName(user)}, we could not confirm your payment of ${money(p.amount)}, so your wallet was not credited. If money left your account, it will be returned by your bank or Flutterwave. If you need help, contact us with the reference below.`,
      rows: rows.slice(0, 3),
      button: dashboard()
    });
  }
});

// ---------------------------------------------------------------- withdrawals
const notifyWithdrawal = safe(async (user, w) => {
  const rows = [['Amount', money(w.amount)], ['To', [w.bankName, w.accountNumber].filter(Boolean).join(' · ')], ['Account name', w.accountName], ['Date', when()], ['Wallet balance', w.balance !== undefined ? money(w.balance) : '']];
  const map = {
    success: { tone: 'success', title: 'Withdrawal successful', intro: `Hi ${firstName(user)}, your withdrawal of ${money(w.amount)} has been sent to your bank account.` },
    pending: { tone: 'pending', title: 'Withdrawal received', intro: `Hi ${firstName(user)}, your withdrawal of ${money(w.amount)} is being processed. We will email you when it is complete.` },
    failed: { tone: 'failed', title: 'Withdrawal failed', intro: `Hi ${firstName(user)}, your withdrawal of ${money(w.amount)} could not be completed. The money has been returned to your wallet.` }
  };
  const m = map[w.state] || map.pending;
  await send(user, 'emailOrders', { subject: `${m.title}: ${money(w.amount)}`, tone: m.tone, title: m.title, intro: m.intro, rows, button: dashboard() });
});

// ---------------------------------------------------------------- transfers
const notifyTransfer = safe(async (user, t) => {
  const out = t.direction === 'out';
  await send(user, 'emailOrders', {
    subject: out ? `You sent ${money(t.amount)}` : `You received ${money(t.amount)}`,
    tone: 'success',
    title: out ? 'Transfer sent' : 'You received money',
    intro: out
      ? `Hi ${firstName(user)}, you sent ${money(t.amount)} to ${t.counterparty}.`
      : `Hi ${firstName(user)}, ${t.counterparty} sent you ${money(t.amount)}. It is now in your wallet.`,
    rows: [['Amount', money(t.amount)], [out ? 'To' : 'From', t.counterparty], ['Reference', t.reference], ['Date', when()], ['Wallet balance', t.balance !== undefined ? money(t.balance) : '']],
    button: dashboard()
  });
});

// ---------------------------------------------------------------- airtime to cash
const notifyA2C = safe(async (user, a) => {
  const map = {
    pending: { tone: 'pending', title: 'Airtime-to-cash request received', intro: `Hi ${firstName(user)}, we received your request and will credit ${money(a.cashValue)} to your wallet once we confirm the airtime arrived.` },
    success: { tone: 'success', title: 'Airtime-to-cash approved', intro: `Hi ${firstName(user)}, we confirmed your airtime and ${money(a.cashValue)} has been added to your wallet.` },
    failed: { tone: 'failed', title: 'Airtime-to-cash not approved', intro: `Hi ${firstName(user)}, we could not confirm that the airtime arrived, so this request was not approved.${a.note ? ` Reason: ${a.note}` : ''}` }
  };
  const m = map[a.state] || map.pending;
  await send(user, 'emailOrders', {
    subject: m.title, tone: m.tone, title: m.title, intro: m.intro,
    rows: [['Network', String(a.network || '').toUpperCase()], ['Airtime sent', money(a.amountSent)], ['Cash value', money(a.cashValue)], ['Date', when()]],
    button: dashboard()
  });
});

// ---------------------------------------------------------------- account & security
function describeDevice(ua = '') {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iPhone / iPad' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X|Macintosh/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Unknown device';
  const browser = /Edg\//i.test(ua) ? 'Edge' : /OPR\/|Opera/i.test(ua) ? 'Opera' : /Firefox\//i.test(ua) ? 'Firefox' : /Chrome\//i.test(ua) ? 'Chrome' : /Safari\//i.test(ua) ? 'Safari' : 'Unknown browser';
  return `${browser} on ${os}`;
}
const ipOf = (req) => String((req && req.ip) || '').replace(/^::ffff:/, '') || 'Unknown';

const notifyLogin = safe(async (user, req) => {
  await send(user, 'emailLogins', {
    subject: 'New login to your Elmubarak account',
    tone: 'security',
    title: 'New login to your account',
    intro: `Hi ${firstName(user)}, your account was just logged in to. If this was you, there is nothing to do.`,
    rows: [['Time', when()], ['Device', describeDevice(req && req.headers && req.headers['user-agent'])], ['IP address', ipOf(req)]],
    button: { text: "This wasn't me: secure my account", url: `${frontendUrl()}/forgot-password.html?email=${encodeURIComponent(user.email)}` },
    notes: ['If you do not recognise this login, reset your password right away using the button above.']
  });
});

const notifyFailedLogins = safe(async (user, count, req) => {
  await send(user, 'emailLogins', {
    subject: 'Someone is trying to log in to your account',
    tone: 'alert',
    title: 'Several failed login attempts',
    intro: `Hi ${firstName(user)}, there were ${count} failed attempts to log in to your account in a short time. If this was you, you can ignore this email. If not, we recommend changing your password.`,
    rows: [['Time', when()], ['Device', describeDevice(req && req.headers && req.headers['user-agent'])], ['IP address', ipOf(req)]],
    button: { text: 'Change my password', url: `${frontendUrl()}/forgot-password.html?email=${encodeURIComponent(user.email)}` }
  });
});

const notifyPasswordChanged = safe(async (user, req) => {
  await send(user, null, {
    subject: 'Your password was changed',
    tone: 'security',
    title: 'Your password was changed',
    intro: `Hi ${firstName(user)}, the password for your account was just changed.`,
    rows: [['Time', when()], ['Device', describeDevice(req && req.headers && req.headers['user-agent'])], ['IP address', ipOf(req)]],
    notes: ["If you did not do this, contact us on WhatsApp straight away so we can secure your account."]
  });
});

const notifyWelcome = safe(async (user) => {
  await send(user, null, {
    subject: `Welcome to Elmubarak Digital Hub`,
    tone: 'success',
    title: `Welcome aboard, ${firstName(user)}!`,
    intro: 'Your email is verified and your account is ready. Fund your wallet to buy airtime, data, electricity, cable TV and more in seconds.',
    button: dashboard()
  });
});

const notifyWalletAdjust = safe(async (user, a) => {
  const credit = a.amount > 0;
  await send(user, 'emailOrders', {
    subject: credit ? `${money(a.amount)} added to your wallet` : `${money(Math.abs(a.amount))} deducted from your wallet`,
    tone: credit ? 'success' : 'pending',
    title: credit ? 'Your wallet was credited' : 'Your wallet was adjusted',
    intro: `Hi ${firstName(user)}, our team ${credit ? 'added' : 'deducted'} ${money(Math.abs(a.amount))} ${credit ? 'to' : 'from'} your wallet.`,
    rows: [['Reason', a.reason || 'Wallet adjustment'], ['Date', when()], ['Wallet balance', money(a.balance)]],
    button: dashboard()
  });
});

const notifyAccountStatus = safe(async (user, suspended, reason) => {
  await send(user, null, {
    subject: suspended ? 'Your account has been suspended' : 'Your account has been reactivated',
    tone: suspended ? 'failed' : 'success',
    title: suspended ? 'Your account has been suspended' : 'Your account is active again',
    intro: suspended
      ? `Hi ${firstName(user)}, your account has been suspended${reason ? `: ${reason}` : ''}. Please contact us on WhatsApp if you think this is a mistake.`
      : `Hi ${firstName(user)}, your account has been reactivated. You can log in and use it as normal.`,
    button: suspended ? null : dashboard()
  });
});

// ---------------------------------------------------------------- admin alerts
const lastSent = new Map();

async function adminRecipients() {
  const fromEnv = (process.env.ADMIN_ALERT_EMAIL || '').split(/[,\s]+/).map((e) => e.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  const admins = await User.find({ isAdmin: true, suspended: { $ne: true } });
  const list = (admins || []).map((a) => a.email).filter(Boolean).slice(0, 5);
  if (list.length) return list;
  return process.env.ADMIN_EMAIL ? [process.env.ADMIN_EMAIL] : [];
}

// a: { key, level: 'info'|'warning'|'critical', title, message, rows, throttleMs, button }
// `key` + `throttleMs` stop the same problem from emailing you over and over.
const alertAdmin = safe(async (a) => {
  const s = await getSettings();
  if (s.emailAdminAlerts === false) return;

  const now = Date.now();
  if (a.throttleMs && a.key) {
    const last = lastSent.get(a.key);
    if (last && now - last < a.throttleMs) return;
    lastSent.set(a.key, now);
  }

  const to = await adminRecipients();
  if (!to.length) return;
  const level = a.level || 'warning';
  await sendBranded({
    to,
    subject: `[Elmubarak ${level.toUpperCase()}] ${a.title}`,
    tone: level === 'info' ? 'info' : 'alert',
    title: a.title,
    intro: a.message,
    rows: [...(a.rows || []), ['Time', when()]],
    button: a.button || { text: 'Open admin panel', url: `${frontendUrl()}/admin.html` },
    notes: ['You are receiving this because you are an admin of Elmubarak Digital Hub. You can switch admin alerts off in Admin panel > Services & plans > Site.']
  });
});

module.exports = {
  notifyOrder, notifyPayment, notifyWithdrawal, notifyTransfer, notifyA2C,
  notifyLogin, notifyFailedLogins, notifyPasswordChanged, notifyWelcome, notifyWalletAdjust, notifyAccountStatus,
  alertAdmin, money
};
