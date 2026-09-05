// Paystack integration for wallet funding.
//
// PROVIDER_MODE=mock -> skips Paystack entirely and credits the wallet
//                       instantly, so you can test the whole flow with
//                       no payment account.
// PROVIDER_MODE=live -> initializes a real Paystack transaction and
//                       verifies it via the API before crediting the wallet.
//
// To go live:
//   1. Create an account at https://paystack.com
//   2. Complete their business verification.
//   3. Copy your TEST secret/public keys first, confirm the flow works.
//   4. Switch to LIVE keys once you're ready to accept real money.
//   5. Set PROVIDER_MODE=live in your .env

const axios = require('axios');
const { generateRef } = require('../utils/helpers');

const isLive = () => process.env.PROVIDER_MODE === 'live';

const client = () =>
  axios.create({
    baseURL: 'https://api.paystack.co',
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    }
  });

async function initializeFunding({ email, amount }) {
  const reference = generateRef('FUND');

  if (!isLive()) {
    return {
      ok: true,
      reference,
      mock: true,
      authorization_url: null,
      message: 'Mock mode: wallet will be credited immediately without a real payment.'
    };
  }

  try {
    const { data } = await client().post('/transaction/initialize', {
      email,
      amount: Math.round(amount * 100), // Paystack uses kobo
      reference
    });
    return {
      ok: true,
      reference,
      authorization_url: data?.data?.authorization_url
    };
  } catch (err) {
    return {
      ok: false,
      message: err.response?.data?.message || 'Could not start payment with Paystack.'
    };
  }
}

async function verifyFunding(reference) {
  if (!isLive()) {
    return { ok: true, mock: true };
  }

  try {
    const { data } = await client().get(`/transaction/verify/${reference}`);
    return { ok: data?.data?.status === 'success', raw: data?.data };
  } catch (err) {
    return { ok: false, message: err.response?.data?.message || 'Could not verify payment.' };
  }
}

module.exports = { initializeFunding, verifyFunding };
