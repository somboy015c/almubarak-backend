const mongoose = require('mongoose');

// One notice in one customer's inbox. Shown as a popup until they dismiss it.
const notificationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  announcementId: String,
  title: String,
  message: String,
  buttonText: { type: String, default: '' },
  buttonUrl: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, index: true, expires: 60 * 60 * 24 * 180 }, // kept 180 days
  readAt: { type: Date, default: null }
});

module.exports = mongoose.model('Notification', notificationSchema);
