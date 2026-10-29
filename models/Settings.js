const mongoose = require('mongoose');

// One document holding everything the admin can switch on/off.
const settingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'site' },

  // Whole services: airtime, data, electricity, cable, exam, funding, transfer, withdrawal, airtime-to-cash
  // Exam PINs start switched off until the admin has tested one purchase.
  disabledServices: { type: [String], default: ['exam'] },
  disabledNetworks: { type: [String], default: [] }, // mtn, glo, airtel, 9mobile (airtime + data)
  disabledDiscos: { type: [String], default: [] }, // provider disco ids, as strings
  disabledCables: { type: [String], default: [] }, // dstv, gotv, startimes
  disabledCategories: { type: [String], default: [] }, // "mtn|SME2" (data plan groups)
  disabledPlans: { type: [String], default: [] }, // "data:389", "cable:20", "exam:WAEC"

  maintenance: { type: Boolean, default: false }, // blocks all purchases/payments
  maintenanceMessage: { type: String, default: 'We are doing some maintenance. Please check back shortly.' },
  notice: { type: String, default: '' }, // banner shown to every customer

  // "Get the app" badge on the public homepage
  appDownloadEnabled: { type: Boolean, default: true },
  appDownloadUrl: { type: String, default: '' }, // empty = use the link in the website's config.js

  // Emails
  emailOrders: { type: Boolean, default: true }, // order / payment / withdrawal emails to customers
  emailLogins: { type: Boolean, default: true }, // "new login" security email to customers
  emailAdminAlerts: { type: Boolean, default: true } // security + operations emails to admins
});

const Settings = mongoose.model('Settings', settingsSchema);

let cache = { at: 0, doc: null };

async function getSettings(force = false) {
  if (!force && cache.doc && Date.now() - cache.at < 10000) return cache.doc;
  let doc = await Settings.findById('site');
  if (!doc) doc = await Settings.create({ _id: 'site' });
  cache = { at: Date.now(), doc };
  return doc;
}

function clearSettingsCache() {
  cache = { at: 0, doc: null };
}

const SERVICES = ['airtime', 'data', 'electricity', 'cable', 'exam', 'funding', 'transfer', 'withdrawal', 'airtime-to-cash'];

const isServiceOn = (s, key) => !s.maintenance && !s.disabledServices.includes(key);

module.exports = { Settings, getSettings, clearSettingsCache, SERVICES, isServiceOn };
