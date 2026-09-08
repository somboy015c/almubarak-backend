const mongoose = require('mongoose');

// Singleton document — there's only ever one pricing config, keyed by a fixed _id.
const pricingSchema = new mongoose.Schema({
  _id: { type: String, default: 'singleton' },
  airtime: { markupPercent: { type: Number, default: 0 } },
  data: { markupPercent: { type: Number, default: 2 } },
  electricity: { markupPercent: { type: Number, default: 1.5 } },
  cable: { markupPercent: { type: Number, default: 1.5 } },
  exam: { flatFee: { type: Number, default: 100 } },
  airtimeToCash: { ratePercent: { type: Number, default: 80 } },
  withdrawal: { minAmount: { type: Number, default: 500 } }
});

const Pricing = mongoose.model('Pricing', pricingSchema);

// Ensures the singleton document exists, returns it.
async function getOrCreatePricing() {
  let doc = await Pricing.findById('singleton');
  if (!doc) {
    doc = await Pricing.create({ _id: 'singleton' });
  }
  return doc;
}

module.exports = { Pricing, getOrCreatePricing };
