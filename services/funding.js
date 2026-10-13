// Settles a wallet-funding payment. Used by BOTH the browser "verify" call and
// the Flutterwave webhook, so a payment is credited exactly once even if both
// arrive at the same moment (or the customer closes the tab after paying).

const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Funding = require('../models/Funding');
const Transaction = require('../models/Transaction');
const flutterwave = require('./flutterwave');

// Returns { state: 'success' | 'pending' | 'failed' | 'not-found', alreadyCredited? }
async function settleFunding(reference) {
  const funding = await Funding.findOne({ reference });
  if (!funding) return { state: 'not-found' };
  if (funding.status === 'success') return { state: 'success', alreadyCredited: true, funding };

  const result = await flutterwave.verifyFunding(reference, funding.amount);

  if (result.state === 'failed') {
    await Funding.updateOne({ reference, status: { $ne: 'success' } }, { status: 'failed' });
    return { state: 'failed', funding };
  }
  if (result.state !== 'success') return { state: 'pending', funding };

  // Atomically claim the credit: only one caller can flip it to success.
  const claimed = await Funding.findOneAndUpdate(
    { reference, status: { $ne: 'success' } },
    { status: 'success' },
    { new: true }
  );
  if (!claimed) return { state: 'success', alreadyCredited: true, funding };

  await User.updateOne({ id: claimed.userId }, { $inc: { walletBalance: Number(claimed.amount) } });
  await Transaction.create({
    id: uuidv4(),
    userId: claimed.userId,
    type: 'wallet-funding',
    description: 'Wallet funding',
    amount: Number(claimed.amount),
    status: 'success',
    reference: claimed.reference
  });

  return { state: 'success', funding: claimed };
}

module.exports = { settleFunding };
