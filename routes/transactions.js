const express = require('express');
const Transaction = require('../models/Transaction');
const { requireAuth } = require('../middleware/auth');
const { settlePendingTransaction, SERVICE_TYPES } = require('../services/settle');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  let transactions = await Transaction.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(300);

  // Opportunistically settle recent pending service orders (checks VTpass).
  const stale = transactions
    .filter((t) => t.status === 'pending' && SERVICE_TYPES.includes(t.type) && Date.now() - new Date(t.createdAt).getTime() > 15000)
    .slice(0, 5);
  if (stale.length) {
    await Promise.all(stale.map((t) => settlePendingTransaction(t)));
    transactions = await Transaction.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(300);
  }

  res.json({ transactions });
});

module.exports = router;
