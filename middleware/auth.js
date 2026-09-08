const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'You need to be signed in to do that.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findOne({ id: payload.id });
    if (!user) {
      return res.status(401).json({ error: 'Your session is no longer valid. Please sign in again.' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'This action is restricted to admins.' });
  }
  next();
}

// Guards any endpoint that moves money (transfer, withdrawal, airtime-to-cash).
// Requires the user to already have a PIN set, and the request body to
// include the correct `pin`.
async function requirePin(req, res, next) {
  if (!req.user.transactionPin) {
    return res.status(400).json({ error: 'Please set a transaction PIN in Settings first.' });
  }
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ error: 'Your transaction PIN is required.' });
  }
  const match = await bcrypt.compare(String(pin), req.user.transactionPin);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect transaction PIN.' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requirePin };
