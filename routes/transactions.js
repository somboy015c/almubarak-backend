const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const transactions = db
    .get('transactions')
    .filter({ userId: req.user.id })
    .orderBy(['createdAt'], ['desc'])
    .value();

  res.json({ transactions });
});

module.exports = router;
