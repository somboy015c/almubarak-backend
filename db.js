// Simple file-based JSON database (lowdb v1).
// Good enough for a starter/small business deployment.
// For heavier traffic, swap this out for Postgres/MongoDB Atlas —
// the rest of the app only talks to the functions exported here,
// so that swap does not require touching routes/services.

const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const file = path.join(__dirname, 'data', 'db.json');
const adapter = new FileSync(file);
const db = low(adapter);

db.defaults({
  users: [],
  transactions: [],
  fundings: [],
  pricing: {
    airtime: { markupPercent: 0 },
    data: { markupPercent: 2 },
    electricity: { markupPercent: 1.5 },
    cable: { markupPercent: 1.5 },
    exam: { flatFee: 100 }
  }
}).write();

module.exports = db;
