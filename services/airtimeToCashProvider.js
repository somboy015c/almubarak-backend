// Automatic airtime-to-cash verification.
//
// Unlike VTpass (buying airtime) or Paystack (payments/transfers), there
// isn't one standard, universally-used API for verifying an *incoming*
// airtime transfer from an arbitrary customer — this is why most Nigerian
// VTU platforms handle it manually (an admin checks their recharge-pin
// balance or SMS alert and approves by hand).
//
// This file gives you a slot to plug a real provider into if/when you
// contract with one (some resellers and aggregators offer this as an
// add-on service — ask whichever VTU aggregator you use for VTpass-style
// services whether they also offer airtime-to-cash verification, since
// it's sometimes bundled).
//
// PROVIDER_MODE=mock -> always simulates a successful verification, so the
//                       "automatic" option is fully testable with no
//                       external account.
// PROVIDER_MODE=live -> calls AIRTIME2CASH_API_URL if you've set one.
//                       Without it configured, automatic requests
//                       automatically fall back to manual review so
//                       nothing silently breaks.

const axios = require('axios');

const isLive = () => process.env.PROVIDER_MODE === 'live';

async function verify({ network, amountSent, phoneUsed }) {
  if (!isLive()) {
    await new Promise((r) => setTimeout(r, 500));
    return { ok: true, verified: true, message: 'Mock mode: airtime verified instantly.' };
  }

  if (!process.env.AIRTIME2CASH_API_URL) {
    // No real provider configured yet — fall back to manual so the
    // request doesn't just vanish. The route handling this treats
    // `fellBackToManual: true` as "queue it for admin review instead".
    return { ok: true, verified: false, fellBackToManual: true };
  }

  try {
    const { data } = await axios.post(
      process.env.AIRTIME2CASH_API_URL,
      { network, amount: amountSent, phone: phoneUsed },
      { headers: { Authorization: `Bearer ${process.env.AIRTIME2CASH_API_KEY || ''}` } }
    );
    return { ok: true, verified: !!data?.verified, raw: data };
  } catch (err) {
    return { ok: false, verified: false, message: err.response?.data?.message || 'Verification provider error.' };
  }
}

module.exports = { verify };
