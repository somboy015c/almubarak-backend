const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const { publicUser, createToken, hashToken } = require('../utils/helpers');
const { requireAuth } = require('../middleware/auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/email');
const { logEvent } = require('../utils/log');

const router = express.Router();

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
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

async function issueVerification(user) {
  const { raw, hash } = createToken();
  user.verifyTokenHash = hash;
  user.verifyTokenExpires = new Date(Date.now() + VERIFY_TTL_MS);
  user.verifyEmailSentAt = new Date();
  await user.save();
  return sendVerificationEmail(user, raw);
}

// ---- Register: creates the account, emails a verification link. No session yet. ----
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
        error: 'This email is already registered but not verified yet. Check your inbox, or request a new verification link.',
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

  const sent = await issueVerification(user);
  logEvent({ category: 'auth', action: 'register', message: `New account: ${user.email}`, user: { id: user.id, email: user.email }, req, meta: { emailSent: !!sent.ok } });
  if (!sent.ok) logEvent({ category: 'system', level: 'error', action: 'email.failed', message: `Verification email could not be sent to ${user.email}`, user: { id: user.id, email: user.email } });

  res.status(201).json({
    message: sent.ok
      ? 'Account created. We sent a verification link to your email.'
      : 'Account created, but we could not send the verification email. Use "Resend" on the next screen.',
    email: user.email,
    emailSent: !!sent.ok
  });
});

// ---- Verify email (called by verify-email.html with the token from the link) ----
router.post('/verify-email', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Verification link is invalid.' });
  }

  const user = await User.findOne({ verifyTokenHash: hashToken(token) });
  if (!user) {
    return res.status(400).json({
      error: 'This verification link is invalid or has already been used.',
      code: 'TOKEN_INVALID'
    });
  }
  if (!user.verifyTokenExpires || user.verifyTokenExpires.getTime() < Date.now()) {
    return res.status(400).json({
      error: 'This verification link has expired. Please request a new one.',
      code: 'TOKEN_EXPIRED',
      email: user.email
    });
  }

  user.emailVerified = true;
  user.verifyTokenHash = null;
  user.verifyTokenExpires = null;
  await user.save();
  logEvent({ category: 'auth', action: 'email.verified', message: `Email verified: ${user.email}`, user: { id: user.id, email: user.email }, req });

  res.json({ message: 'Email verified. You can now log in.' });
});

// ---- Resend verification link ----
// Always answers the same way so it can't be used to discover which emails exist.
router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Please enter your email address.' });
  }

  const user = await User.findOne({ email: String(email).trim().toLowerCase() });
  if (user && isUnverified(user)) {
    if (!cooledDown(user.verifyEmailSentAt)) {
      return res.status(429).json({ error: 'Please wait a minute before requesting another email.' });
    }
    await issueVerification(user);
  }

  res.json({ message: 'If that account exists and is not yet verified, a new verification link is on its way.' });
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
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  if (user.suspended) {
    logEvent({ category: 'auth', level: 'warn', action: 'login.blocked', message: `Suspended account tried to log in: ${user.email}`, user: { id: user.id, email: user.email }, req });
    return res.status(403).json({ error: 'This account has been suspended. Please contact support.', code: 'ACCOUNT_SUSPENDED' });
  }

  // Checked only after the password is correct, so this can't be used to probe emails.
  if (isUnverified(user)) {
    return res.status(403).json({
      error: 'Please verify your email before logging in. Check your inbox for the verification link.',
      code: 'EMAIL_NOT_VERIFIED',
      email: user.email
    });
  }

  user.lastLoginAt = new Date();
  await user.save();
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
  user.resetTokenHash = null;
  user.resetTokenExpires = null;
  // They just proved they own this inbox, so verification is satisfied too.
  user.emailVerified = true;
  user.verifyTokenHash = null;
  user.verifyTokenExpires = null;
  await user.save();
  logEvent({ category: 'auth', action: 'password.reset', message: `Password changed via reset link: ${user.email}`, user: { id: user.id, email: user.email }, req });

  res.json({ message: 'Password updated. You can now log in with your new password.' });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = router;
