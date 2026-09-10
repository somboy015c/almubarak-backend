// Paystack integration for wallet funding AND automated bank withdrawals.
//
// PROVIDER_MODE=mock -> skips Paystack entirely, simulates instant success
//                       for funding, transfers, and account lookups, so you
//                       can test the whole flow with no payment account.
// PROVIDER_MODE=live -> calls the real Paystack API for everything below.
//
// To go live:
//   1. Create an account at https://paystack.com
//   2. Complete their business verification — this is required for BOTH
//      accepting payments AND sending transfers (payouts). Transfers in
//      particular need Paystack to approve your business for that feature.
//   3. Copy your TEST secret/public keys first, confirm funding + a small
//      test withdrawal both work.
//   4. Switch to LIVE keys once you're ready to move real money.
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

// ---- Funding (collecting money in) ----

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

// ---- Bank list (for the withdrawal bank-account form) ----

const MOCK_BANKS = [
  { name: 'Access Bank', code: '044' },
  { name: 'GTBank', code: '058' },
  { name: 'Zenith Bank', code: '057' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'UBA', code: '033' },
  { name: 'Kuda Bank', code: '50211' },
  { name: 'Opay', code: '999992' },
  { name: 'Palmpay', code: '999991' },
  { name: 'Moniepoint MFB', code: '50515' }
];

async function listBanks() {
  if (!isLive()) return MOCK_BANKS;

  try {
    const { data } = await client().get('/bank', { params: { country: 'nigeria' } });
    return (data?.data || []).map((b) => ({ name: b.name, code: b.code }));
  } catch (err) {
    // Fall back to the short mock list rather than breaking the form entirely.
    return MOCK_BANKS;
  }
}

// ---- Account resolution (confirm the account name before saving it) ----

async function resolveAccount({ accountNumber, bankCode }) {
  if (!isLive()) {
    return { ok: true, accountName: 'MOCK ACCOUNT NAME' };
  }

  try {
    const { data } = await client().get('/bank/resolve', {
      params: { account_number: accountNumber, bank_code: bankCode }
    });
    return { ok: true, accountName: data?.data?.account_name };
  } catch (err) {
    return { ok: false, message: err.response?.data?.message || 'Could not verify that account number.' };
  }
}

// ---- Transfers (paying money out for withdrawals) ----

async function createTransferRecipient({ name, accountNumber, bankCode }) {
  if (!isLive()) {
    return { ok: true, recipientCode: `MOCK-RCP-${Date.now()}` };
  }

  try {
    const { data } = await client().post('/transferrecipient', {
      type: 'nuban',
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN'
    });
    return { ok: true, recipientCode: data?.data?.recipient_code };
  } catch (err) {
    return { ok: false, message: err.response?.data?.message || 'Could not set up this bank account with Paystack.' };
  }
}

async function initiateTransfer({ amount, recipientCode, reason }) {
  const reference = generateRef('PAYOUT');

  if (!isLive()) {
    // Simulate an instant successful payout.
    await new Promise((r) => setTimeout(r, 500));
    return { ok: true, status: 'success', reference, providerRef: `MOCK-TRF-${Date.now()}` };
  }

  try {
    const { data } = await client().post('/transfer', {
      source: 'balance',
      amount: Math.round(amount * 100),
      recipient: recipientCode,
      reason,
      reference
    });
    // Paystack can return 'success', 'pending' (needs OTP approval in
    // dashboard) or 'otp' depending on account settings.
    const status = data?.data?.status === 'success' ? 'success' : 'pending';
    return { ok: true, status, reference, providerRef: data?.data?.transfer_code };
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      reference,
      message: err.response?.data?.message || 'Could not send this payout via Paystack.'
    };
  }
}

module.exports = {
  initializeFunding,
  verifyFunding,
  listBanks,
  resolveAccount,
  createTransferRecipient,
  initiateTransfer
};
