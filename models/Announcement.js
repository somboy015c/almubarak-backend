const mongoose = require('mongoose');

// A notice written by an admin and sent to customers (by email and/or as a popup).
const announcementSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, index: true },
  title: String,
  message: String,
  buttonText: { type: String, default: '' },
  buttonUrl: { type: String, default: '' },
  audience: { type: String, default: 'all' }, // all | user
  targetEmail: { type: String, default: '' },
  sendEmail: { type: Boolean, default: true },
  sendPopup: { type: Boolean, default: true },
  createdBy: { id: String, email: String },
  status: { type: String, default: 'sending' }, // sending | done
  stats: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({ recipients: 0, popups: 0, emailsSent: 0, emailsFailed: 0 })
  }
});

module.exports = mongoose.model('Announcement', announcementSchema);
