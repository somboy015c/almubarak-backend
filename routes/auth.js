const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const { publicUser, createToken, hashToken } = require('../utils/helpers');
const { requireAuth } = require('../middleware/auth');
const { sendOtpEmail, sendPasswordResetEmail } = require('../services/email');
const { logEvent } = require('../utils/log');
const { notifyLogin, notifyFailedLogins, notifyPasswordChanged, notifyWelcome, alertAdmin } = require('../services/notify');

// Counts wrong passwords per account so we can warn the owner and the admins
// when someone is guessing. Kept in memory: it resets when the server restarts.
const failures = new Map();
function recordFailure(user, req) {
  const key = user.id;
  const now = Date.now();
  const f = failures.get(key);
  if (!f || now - f.first > 15 * 60 * 1000) {
    failures.set(key, { first: now, count: 1, alerted: false });
    return;
  }
  f.count += 1;
  if (f.count >= 5 && !f.alerted) {
    f.alerted = true;
    notifyFailedLogins(user, f.count, req);
    alertAdmin({
      key: `bruteforce:${user.id}`, level: 'warning', title: `Repeated failed logins for ${user.email}`,
      message: `${f.count} wrong passwords were entered for this account within 15 minutes. The customer has been emailed. If it continues, consider suspending the account.`,
      rows: [['Account', user.email], ['IP address', String(req.ip || '')]], throttleMs: 60 * 60 * 1000
    });
  }
}

const router = express.Router();

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between emails per account

function signToken(user) {
  return jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

// Accounts created before email verification existed have emailVerified
// undefined and keep working. Only an explicit `false` is blocked.
const isUnverified = (user) => user.emailVerified === false;

function cooledDown(sentAt) {
  return !sentAt || Date.now() - new Date(sentAt).getTime() >= RESEND_COOLDOWN_MS;
}

// ---- Sign-up code (OTP): 6 digits, valid 10 minutes, 5 wrong tries, then a new code is needed ----
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const otpHash = (userId, code) => crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-secret').update(`${userId}:${code}`).digest('hex');

async function issueOtp(user) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  user.otpHash = otpHash(user.id, code);
  user.otpExpires = new Date(Date.now() + OTP_TTL_MS);
  user.otpAttempts = 0;
  user.otpSentAt = new Date();
  await user.save();
  return sendOtpEmail(user, code);
}

// ---- Register: creates the account and emails a 6-digit code. No session until the code is entered. ----
router.post('/register', async (req, res) => {
  const { fullName, email, phone, password } = req.body;

  if (!fullName || !email || !phone || !password) {
    return res.status(400).json({ error: 'Full name, email, phone and password are all required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const existing = await User.findOne({ email: cleanEmail });

  if (existing) {
    if (isUnverified(existing)) {
      return res.status(409).json({
        error: 'This email is already registered but not verified yet. Enter the code we email you, or request a new one.',
        code: 'EMAIL_NOT_VERIFIED',
        email: cleanEmail
      });
    }
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const hashed = await bcrypt.hash(password, 10);
  const isFirstUser = (await User.countDocuments()) === 0;
  const isDesignatedAdmin = cleanEmail === (process.env.ADMIN_EMAIL || '').toLowerCase();

  const user = await User.create({
    id: uuidv4(),
    fullName: String(fullName).trim(),
    email: cleanEmail,
    phone: String(phone).trim(),
    password: hashed,
    walletBalance: 0,
    isAdmin: isFirstUser || isDesignatedAdmin,
    emailVerified: false
  });

  const sent = await issueOtp(user);
  logEvent({ category: 'auth', action: 'register', message: `New account: ${user.email}`, user: { id: user.id, email: user.email }, req, meta: { emailSent: !!sent.ok } });
  if (!sent.ok) logEvent({ category: 'system', level: 'error', action: 'email.failed', message: `Verification email could not be sent to ${user.email}`, user: { id: user.id, email: user.email } });

  res.status(201).json({
    message: sent.ok
      ? 'Account created. We sent a 6-digit code to your email.'
      : 'Account created, but we could not send the code. Tap "Resend code" on the next screen.',
    email: user.email,
    emailSent: !!sent.ok,
    otp: true
  });
});

// ---- Enter the code: verifies the email AND signs the customer in, in the same window ----
router.post('/verify-otp', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (!email || code.length !== 6) {
    return res.status(400).json({ error: 'Enter the 6-digit code from your email.', code: 'OTP_INVALID' });
  }

  const wrong = () => res.status(400).json({ error: 'That code is not correct, or it has expired. Check it or request a new one.', code: 'OTP_INVALID' });
  const user = await User.findOne({ email });
  if (!user || !isUnverified(user) || !user.otpHash) return wrong();
  if (user.suspended) return res.status(403).json({ error: 'This account has been suspended. Please contact support.', code: 'ACCOUNT_SUSPENDED' });
  if (!user.otpExpires || user.otpExpires.getTime() < Date.now()) {
    return res.status(400).json({ error: 'This code has expired. Request a new one.', code: 'OTP_EXPIRED' });
  }

  // Every guess uses up one of the 5 tries BEFORE it is checked, so rapid parallel guesses cannot beat the limit.
  const tried = await User.findOneAndUpdate({ id: user.id, otpAttempts: { $lt: OTP_MAX_ATTEMPTS } }, { $inc: { otpAttempts: 1 } }, { new: true });
  if (!tried) {
    return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.', code: 'OTP_LOCKED' });
  }

  const expected = Buffer.from(user.otpHash);
  const given = Buffer.from(otpHash(user.id, code));
  const ok = expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (!ok) {
    const left = OTP_MAX_ATTEMPTS - tried.otpAttempts;
    logEvent({ category: 'auth', level: 'warn', action: 'otp.wrong', message: `Wrong sign-up code for ${user.email}`, user: { id: user.id, email: user.email }, req });
    return res.status(400).json({
      error: left > 0 ? `Incorrect code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong attempts. Request a new code.',
      code: left > 0 ? 'OTP_INVALID' : 'OTP_LOCKED'
    });
  }

  tried.emailVerified = true;
  tried.otpHash = null;
  tried.otpExpires = null;
  tried.otpAttempts = 0;
  tried.verifyTokenHash = null;
  tried.verifyTokenExpires = null;
  tried.lastLoginAt = new Date();
  await tried.save();
  logEvent({ category: 'auth', action: 'email.verified', message: `Email verified with a code: ${tried.email}`, user: { id: tried.id, email: tried.email }, req });
  notifyWelcome(tried);

  res.json({ message: 'Email verified. Welcome!', token: signToken(tried), user: publicUser(tried) });
});

// ---- Resend the sign-up code ----
// Always answers the same way so it can't be used to discover which emails exist.
router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Please enter your email address.' });
  }

  const user = await User.findOne({ email: String(email).trim().toLowerCase() });
  if (user && isUnverified(user)) {
    if (!cooledDown(user.otpSentAt)) {
      return res.status(429).json({ error: 'Please wait a minute before requesting another code.' });
    }
    await issueOtp(user);
  }

  res.json({ message: 'If that account exists and is not yet verified, a new code is on its way.' });
});

// ---- Login: blocked until the email is verified ----
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = await User.findOne({ email: String(email).trim().toLowerCase() });
  if (!user) {
    logEvent({ category: 'auth', level: 'warn', action: 'login.failed', message: `Failed login for unknown email ${String(email).trim().toLowerCase()}`, req });
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    logEvent({ category: 'auth', level: 'warn', action: 'login.failed', message: `Wrong password for ${user.email}`, user: { id: user.id, email: user.email }, req });
    recordFailure(user, req);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  if (user.suspended) {
    logEvent({ category: 'auth', level: 'warn', action: 'login.blocked', message: `Suspended account tried to log in: ${user.email}`, user: { id: user.id, email: user.email }, req });
    return res.status(403).json({ error: 'This account has been suspended. Please contact support.', code: 'ACCOUNT_SUSPENDED' });
  }

  // Checked only after the password is correct, so this can't be used to probe emails.
  if (isUnverified(user)) {
    return res.status(403).json({
      error: 'Please verify your email before logging in. We will send a 6-digit code to your email.',
      code: 'EMAIL_NOT_VERIFIED',
      email: user.email
    });
  }

  user.lastLoginAt = new Date();
  await user.save();
  failures.delete(user.id);
  notifyLogin(user, req);
  logEvent({ category: 'auth', action: 'login', message: `Logged in: ${user.email}`, user: { id: user.id, email: user.email }, req });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// ---- Forgot password ----
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Please enter your email address.' });
  }

  const user = await User.findOne({ email: String(email).trim().toLowerCase() });
  if (user) {
    if (!cooledDown(user.resetEmailSentAt)) {
      return res.status(429).json({ error: 'Please wait a minute before requesting another email.' });
    }
    const { raw, hash } = createToken();
    user.resetTokenHash = hash;
    user.resetTokenExpires = new Date(Date.now() + RESET_TTL_MS);
    user.resetEmailSentAt = new Date();
    await user.save();
    const sent = await sendPasswordResetEmail(user, raw);
    logEvent({ category: 'auth', level: sent.ok ? 'info' : 'error', action: 'password.reset.requested', message: `Password reset link ${sent.ok ? 'sent to' : 'could NOT be sent to'} ${user.email}`, user: { id: user.id, email: user.email }, req });
  }

  res.json({ message: 'If an account exists for that email, we have sent a password reset link.' });
});

// ---- Reset password ----
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Reset link and new password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const user = await User.findOne({ resetTokenHash: hashToken(token) });
  if (!user || !user.resetTokenExpires || user.resetTokenExpires.getTime() < Date.now()) {
    return res.status(400).json({
      error: 'This reset link is invalid or has expired. Please request a new one.',
      code: 'TOKEN_INVALID'
    });
  }

  user.password = await bcrypt.hash(password, 10);
  user.quickDevices = []; // a phone that was lost or shared can't get back in after a reset
  user.resetTokenHash = null;
  user.resetTokenExpires = null;
  // They just proved they own this inbox, so verification is satisfied too.
  user.emailVerified = true;
  user.verifyTokenHash = null;
  user.verifyTokenExpires = null;
  await user.save();
  logEvent({ category: 'auth', action: 'password.reset', message: `Password changed via reset link: ${user.email}`, user: { id: user.id, email: user.email }, req });
  notifyPasswordChanged(user, req);

  res.json({ message: 'Password updated. You can now log in with your new password.' });
});

// ---- App quick login: a 4-digit PIN or fingerprint on a phone that signed in with the password once ----
const QUICK_MAX_DEVICES = 5;
const QUICK_MAX_PIN_TRIES = 5;
const QUICK_UNUSED_LIMIT_MS = 90 * 24 * 60 * 60 * 1000;
const randomSecret = () => crypto.randomBytes(32).toString('hex');
const sameHash = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};
const quickRevoked = (res, status = 410) => res.status(status).json({ error: 'PIN login has been turned off on this phone. Please log in with your password.', code: 'DEVICE_REVOKED' });

router.post('/device/enroll', requireAuth, async (req, res) => {
  const pin = String(req.body.pin || '');
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'Your PIN must be exactly 4 digits.' });

  const secret = randomSecret();
  const bioSecret = req.body.biometric ? randomSecret() : null;
  const device = {
    deviceId: uuidv4(),
    secretHash: hashToken(secret),
    bioSecretHash: bioSecret ? hashToken(bioSecret) : null,
    pinHash: await bcrypt.hash(pin, 10)
  };

  const user = await User.findOne({ id: req.user.id });
  user.quickDevices = [...user.quickDevices.filter((d) => d.deviceId !== req.body.replaceDeviceId), device].slice(-QUICK_MAX_DEVICES);
  await user.save();
  logEvent({ category: 'auth', action: 'quick-login.enabled', message: `PIN login turned on for a phone: ${user.email}`, user: { id: user.id, email: user.email }, req, meta: { biometric: !!bioSecret } });
  res.status(201).json({ deviceId: device.deviceId, secret, bioSecret });
});

router.post('/device/remove', requireAuth, async (req, res) => {
  await User.updateOne({ id: req.user.id }, { $pull: { quickDevices: { deviceId: String(req.body.deviceId || '') } } });
  res.json({ message: 'PIN login turned off for this phone.' });
});

router.post('/device/login', async (req, res) => {
  const deviceId = String(req.body.deviceId || '');
  if (!deviceId) return quickRevoked(res, 400);
  const user = await User.findOne({ 'quickDevices.deviceId': deviceId });
  const device = user && user.quickDevices.find((d) => d.deviceId === deviceId);
  if (!device || isUnverified(user)) return quickRevoked(res);
  if (user.suspended) return res.status(403).json({ error: 'This account has been suspended. Please contact support.', code: 'ACCOUNT_SUSPENDED' });

  const forget = () => User.updateOne({ id: user.id }, { $pull: { quickDevices: { deviceId } } });
  if (Date.now() - new Date(device.lastUsedAt).getTime() > QUICK_UNUSED_LIMIT_MS) {
    await forget();
    return quickRevoked(res);
  }

  const { bioSecret, secret, pin } = req.body;
  if (bioSecret) {
    if (!device.bioSecretHash || !sameHash(device.bioSecretHash, hashToken(String(bioSecret)))) return quickRevoked(res, 403);
  } else {
    if (!sameHash(device.secretHash, hashToken(String(secret || '')))) return quickRevoked(res, 403);
    // Each guess uses up a try BEFORE it is checked, so rapid parallel guesses cannot beat the limit.
    const tried = await User.findOneAndUpdate(
      { id: user.id, quickDevices: { $elemMatch: { deviceId, attempts: { $lt: QUICK_MAX_PIN_TRIES } } } },
      { $inc: { 'quickDevices.$.attempts': 1 } },
      { new: true }
    );
    if (!tried) {
      await forget();
      return quickRevoked(res);
    }
    if (!(await bcrypt.compare(String(pin || ''), device.pinHash))) {
      const used = tried.quickDevices.find((d) => d.deviceId === deviceId).attempts;
      const left = QUICK_MAX_PIN_TRIES - used;
      logEvent({ category: 'auth', level: 'warn', action: 'quick-login.wrong-pin', message: `Wrong app PIN for ${user.email}`, user: { id: user.id, email: user.email }, req });
      if (left <= 0) {
        await forget();
        return quickRevoked(res);
      }
      return res.status(400).json({ error: `Incorrect PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`, code: 'PIN_INVALID' });
    }
  }

  const now = new Date();
  await User.updateOne({ id: user.id, 'quickDevices.deviceId': deviceId }, { $set: { 'quickDevices.$.attempts': 0, 'quickDevices.$.lastUsedAt': now, lastLoginAt: now } });
  logEvent({ category: 'auth', action: 'quick-login', message: `Unlocked the app: ${user.email}`, user: { id: user.id, email: user.email }, req, meta: { method: bioSecret ? 'fingerprint' : 'pin' } });
  res.json({ token: signToken(user), user: publicUser(user) });
});

// ---- Account deletion request (required by Google Play) ----
// The account is not wiped automatically: an admin settles any wallet balance first,
// then deletes it. The customer must confirm with their password.
router.post('/delete-request', requireAuth, async (req, res) => {
  const user = await User.findOne({ id: req.user.id });
  if (!(await bcrypt.compare(String(req.body.password || ''), user.password))) {
    return res.status(400).json({ error: 'Incorrect password.' });
  }
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  user.deletionRequestedAt = new Date();
  user.quickDevices = [];
  await user.save();

  logEvent({ category: 'auth', level: 'warn', action: 'account.delete-request', message: `Account deletion requested: ${user.email}`, user: { id: user.id, email: user.email }, req, meta: { reason } });
  alertAdmin({
    level: 'warning',
    title: 'Account deletion requested',
    message: `${user.fullName || user.email} has asked for their account to be deleted. Settle any wallet balance with them, then delete the account.`,
    rows: [['Name', user.fullName], ['Email', user.email], ['Phone', user.phone], ['Wallet balance', `NGN ${Number(user.walletBalance || 0).toFixed(2)}`], ['Reason', reason || 'Not given']]
  });
  res.json({ message: 'Your request has been sent. Our team will contact you within 7 days to settle any wallet balance and delete your account.' });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = router;
