#!/usr/bin/env node
/*
 * Clean the database before going live.
 *
 * Removes every test transaction, order, payment record, withdrawal, airtime-to-cash request,
 * notice and activity-log entry, and sets customer wallet balances back to zero.
 *
 * It does NOT touch: admin accounts, your pricing and markup, your service switches, the airtime-to-cash
 * numbers, or anything held at Arrifqubundle or Flutterwave.
 *
 * Usage (from the backend folder, with MONGODB_URI in your .env):
 *   node scripts/reset-for-launch.js                          shows what WOULD happen. Changes nothing.
 *   node scripts/reset-for-launch.js --confirm=RESET          really does it (after saving a backup)
 *
 * Options:
 *   --delete-customers   also delete every NON-admin account (use this to remove your test customers)
 *   --keep-logs          keep the activity log
 *   --no-backup          skip the backup file (not recommended)
 *
 * THIS CANNOT BE UNDONE. Only run it before real customers have put real money on the website.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const confirmed = args.includes('--confirm=RESET');
const deleteCustomers = flag('delete-customers');
const keepLogs = flag('keep-logs');
const backup = !flag('no-backup');

const models = {
  transactions: require('../models/Transaction'),
  payments: require('../models/Funding'),
  withdrawals: require('../models/Withdrawal'),
  airtimeToCash: require('../models/AirtimeToCash'),
  notifications: require('../models/Notification'),
  notices: require('../models/Announcement'),
  logs: require('../models/Log')
};
const User = require('../models/User');

const maskUri = (uri) => String(uri || '').replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
const naira = (n) => `NGN ${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Put it in a .env file in the backend folder (the same value your server uses).');
    process.exit(1);
  }
  console.log(`\nDatabase: ${maskUri(process.env.MONGODB_URI)}`);
  await mongoose.connect(process.env.MONGODB_URI);

  const users = await User.find({});
  const customers = users.filter((u) => !u.isAdmin);
  const admins = users.filter((u) => u.isAdmin);
  const owed = customers.reduce((t, u) => t + Number(u.walletBalance || 0), 0);

  const counts = {};
  for (const [name, model] of Object.entries(models)) counts[name] = await model.countDocuments({});

  console.log('\nWhat is in the database now:');
  console.log(`  Transactions ........... ${counts.transactions}`);
  console.log(`  Payment records ........ ${counts.payments}`);
  console.log(`  Withdrawals ............ ${counts.withdrawals}`);
  console.log(`  Airtime-to-cash ........ ${counts.airtimeToCash}`);
  console.log(`  Notices sent ........... ${counts.notices} (customer popups: ${counts.notifications})`);
  console.log(`  Activity log entries ... ${counts.logs}${keepLogs ? '  (will be KEPT)' : ''}`);
  console.log(`  Admin accounts ......... ${admins.length}  (always kept)`);
  console.log(`  Customer accounts ...... ${customers.length}  ${deleteCustomers ? '(will be DELETED)' : '(kept, wallets set to 0)'}`);
  console.log(`  Money in customer wallets: ${naira(owed)}`);

  if (owed > 0) {
    console.log('\n  !!  Customers currently have money in their wallets. If any of it is REAL money, resetting wallets');
    console.log('      to zero means you would no longer owe it on the website. Only continue if all of it is test money.');
  }

  if (!confirmed) {
    console.log('\nDRY RUN: nothing was changed.');
    console.log('To really do it, run again with:  --confirm=RESET');
    await mongoose.disconnect();
    return;
  }

  if (backup) {
    const dir = path.join(__dirname, '..', 'backups', `launch-reset-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, model] of Object.entries(models)) {
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(await model.find({}), null, 2));
    }
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users, null, 2));
    console.log(`\nBackup saved in: ${dir}`);
    console.log('(It contains customer data. Keep it private, and delete it when you no longer need it.)');
  }

  console.log('\nCleaning...');
  for (const [name, model] of Object.entries(models)) {
    if (name === 'logs' && keepLogs) continue;
    const r = await model.deleteMany({});
    console.log(`  cleared ${name}: ${r.deletedCount ?? 'ok'}`);
  }

  if (deleteCustomers) {
    const r = await User.deleteMany({ isAdmin: { $ne: true } });
    console.log(`  deleted customer accounts: ${r.deletedCount ?? 'ok'}`);
  }
  await User.updateMany({}, { $set: { walletBalance: 0 } });
  console.log('  all remaining wallet balances set to 0');

  console.log('\nDone. The website is clean and ready for live use.');
  console.log('Reminder: set PROVIDER_MODE=live and use your LIVE keys, then make one small real test purchase.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
