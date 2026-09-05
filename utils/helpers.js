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
  const { password, ...rest } = user;
  return rest;
}

module.exports = { generateRef, applyMarkup, publicUser };
