const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

function generateRef(prefix = 'ALM') {
  return `${prefix}-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
}

function applyMarkup(providerCost, markupPercent = 0) {
  const cost = Number(providerCost);
  const finalPrice = cost + cost * (Number(markupPercent) / 100);
  return Math.round(finalPrice * 100) / 100;
}

function publicUser(user) {
  if (!user) return null;
  const plain = typeof user.toObject === 'function' ? user.toObject() : user;
  const {
    password, transactionPin, _id, __v,
    verifyTokenHash, verifyTokenExpires, verifyEmailSentAt,
    resetTokenHash, resetTokenExpires, resetEmailSentAt,
    ...rest
  } = plain;
  rest.hasPin = !!transactionPin;
  return rest;
}

// One-time tokens for email links. The raw token goes in the email; only its
// hash is stored, so a leaked database can't be used to verify/reset accounts.
function createToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: hashToken(raw) };
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

module.exports = { generateRef, applyMarkup, publicUser, createToken, hashToken };
