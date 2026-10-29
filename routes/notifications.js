const express = require('express');
const Notification = require('../models/Notification');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Latest notices for the logged-in customer, with how many are unread.
router.get('/', async (req, res) => {
  const list = await Notification.find({ userId: req.user.id });
  const sorted = list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 30);
  res.json({
    unread: list.filter((n) => !n.readAt).length,
    notifications: sorted.map((n) => ({
      id: n.id, title: n.title, message: n.message, buttonText: n.buttonText, buttonUrl: n.buttonUrl,
      createdAt: n.createdAt, read: !!n.readAt
    }))
  });
});

// Mark notices as read (after the customer dismisses the popup).
router.post('/read', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String).slice(0, 100) : [];
  const filter = { userId: req.user.id, readAt: null };
  if (!req.body.all) {
    if (!ids.length) return res.status(400).json({ error: 'Nothing to mark.' });
    filter.id = { $in: ids };
  }
  await Notification.updateMany(filter, { readAt: new Date() });
  res.json({ message: 'Done.' });
});

module.exports = router;
