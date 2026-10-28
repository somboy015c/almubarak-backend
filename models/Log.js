const mongoose = require('mongoose');

// Activity log. Entries older than 90 days are deleted automatically.
const logSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, index: true, expires: 60 * 60 * 24 * 90 },
  category: { type: String, index: true }, // auth | order | payment | provider | admin | system
  level: { type: String, default: 'info', index: true }, // info | warn | error
  action: String,
  message: String,
  userId: { type: String, index: true },
  userEmail: String,
  actorId: String, // admin who did it, when relevant
  actorEmail: String,
  ip: String,
  meta: { type: mongoose.Schema.Types.Mixed, default: {} }
});

module.exports = mongoose.model('Log', logSchema);
