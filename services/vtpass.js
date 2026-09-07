// VTpass integration.
//
// PROVIDER_MODE=mock  -> no external account needed, returns realistic fake
//                        responses so the whole app works end-to-end today.
// PROVIDER_MODE=live  -> calls the real VTpass API using the credentials in .env.
//
// To go live:
//   1. Create an account at https://vtpass.com
//   2. Verify your business (KYC) — needed before you can sell to real customers.
//   3. Grab your sandbox API key/secret key from the dashboard and test first
//      against VTPASS_BASE_URL=https://sandbox.vtpass.com/api
//   4. Fund your VTpass wallet, switch VTPASS_BASE_URL to
//      https://vtpass.com/api and use your live keys.
//   5. Set PROVIDER_MODE=live in your .env

const axios = require('axios');
const { generateRef } = require('../utils/helpers');

const isLive = () => process.env.PROVIDER_MODE === 'live';

const client = () =>
  axios.create({
    baseURL: process.env.VTPASS_BASE_URL,
    headers: {
      'api-key': process.env.VTPASS_API_KEY,
      'secret-key': process.env.VTPASS_SECRET_KEY,
      'Content-Type': 'application/json'
    }
  });

// Mock catalog so the frontend has real-looking options to pick from
// without any provider account. Prices are in Naira.
const MOCK_CATALOG = {
  data: {
    mtn: [
      { variation_code: 'mtn-100mb-1day', name: '100MB - 1 Day', amount: 100 },
      { variation_code: 'mtn-1gb-1day', name: '1GB - 1 Day', amount: 350 },
      { variation_code: 'mtn-2gb-30day', name: '2GB - 30 Days', amount: 1400 },
      { variation_code: 'mtn-5gb-30day', name: '5GB - 30 Days', amount: 3500 }
    ],
    airtel: [
      { variation_code: 'airtel-1gb-1day', name: '1GB - 1 Day', amount: 300 },
      { variation_code: 'airtel-3gb-7day', name: '3GB - 7 Days', amount: 1000 },
      { variation_code: 'airtel-10gb-30day', name: '10GB - 30 Days', amount: 3000 }
    ],
    glo: [
      { variation_code: 'glo-1.5gb-30day', name: '1.5GB - 30 Days', amount: 1000 },
      { variation_code: 'glo-5.8gb-30day', name: '5.8GB - 30 Days', amount: 2000 }
    ],
    '9mobile': [
      { variation_code: '9mobile-1.5gb-30day', name: '1.5GB - 30 Days', amount: 1200 },
      { variation_code: '9mobile-4.5gb-30day', name: '4.5GB - 30 Days', amount: 2500 }
    ]
  },
  cable: {
    dstv: [
      { variation_code: 'dstv-padi', name: 'DStv Padi', amount: 4400 },
      { variation_code: 'dstv-yanga', name: 'DStv Yanga', amount: 6000 },
      { variation_code: 'dstv-compact', name: 'DStv Compact', amount: 19000 }
    ],
    gotv: [
      { variation_code: 'gotv-smallie', name: 'GOtv Smallie', amount: 1900 },
      { variation_code: 'gotv-jinja', name: 'GOtv Jinja', amount: 3900 },
      { variation_code: 'gotv-max', name: 'GOtv Max', amount: 8500 }
    ],
    startimes: [
      { variation_code: 'startimes-nova', name: 'Nova', amount: 1900 },
      { variation_code: 'startimes-basic', name: 'Basic', amount: 4200 }
    ]
  },
  exam: [
    { variation_code: 'waec-registration', name: 'WAEC Registration PIN', amount: 27300 },
    { variation_code: 'waec-result-checker', name: 'WAEC Result Checker PIN', amount: 3400 },
    { variation_code: 'neco', name: 'NECO Result Checker PIN', amount: 1300 },
    { variation_code: 'jamb-utme-with-mock', name: 'JAMB UTME PIN (with mock)', amount: 7700 },
    { variation_code: 'jamb-utme-without-mock', name: 'JAMB UTME PIN (no mock)', amount: 6200 }
  ]
};

async function getVariations(kind, provider) {
  if (!isLive()) {
    if (kind === 'exam') return MOCK_CATALOG.exam;
    return MOCK_CATALOG[kind]?.[provider] || [];
  }

  // Live: VTpass "service-variations" endpoint.
  // serviceID naming follows VTpass's own catalog, e.g. "mtn-data", "dstv".
  const serviceID = kind === 'data' ? `${provider}-data` : provider;
  const { data } = await client().get('/service-variations', { params: { serviceID } });
  return data?.content?.varations || data?.content?.variations || [];
}

// Generic purchase used for airtime, data, electricity, cable, exam pins.
// `payload` shape depends on `kind` — see routes/services.js for what each sends.
async function purchase(kind, payload) {
  const request_id = generateRef('VTP');

  if (!isLive()) {
    // Simulate network latency and a success response shaped like VTpass's.
    await new Promise((r) => setTimeout(r, 600));

    // Simulate the occasional failure so the app's error handling gets exercised.
    const simulateFailure = payload.phone === '00000000000' || payload.meter === '0000000000';
    if (simulateFailure) {
      return {
        ok: false,
        request_id,
        message: 'Transaction failed at the provider. No charge was made.'
      };
    }

    return {
      ok: true,
      request_id,
      message: 'Transaction successful',
      providerRef: `MOCK-${request_id}`,
      raw: { code: '000', response_description: 'TRANSACTION SUCCESSFUL' }
    };
  }

  // Live VTpass call
  const serviceIDMap = {
    airtime: payload.network,
    data: `${payload.network}-data`,
    electricity: payload.disco,
    cable: payload.provider,
    exam: payload.examBody
  };

  const body = {
    request_id,
    serviceID: serviceIDMap[kind],
    amount: payload.amount,
    phone: payload.phone,
    billersCode: payload.meter || payload.smartcardNumber,
    variation_code: payload.variation_code,
    quantity: payload.quantity || 1
  };

  try {
    const { data } = await client().post('/pay', body);
    const success = data?.code === '000';
    return {
      ok: success,
      request_id,
      message: data?.response_description || (success ? 'Transaction successful' : 'Transaction failed'),
      providerRef: data?.transactionId || request_id,
      raw: data
    };
  } catch (err) {
    return {
      ok: false,
      request_id,
      message: err.response?.data?.response_description || 'Could not reach VTpass. Please try again.',
      raw: err.response?.data
    };
  }
}

module.exports = { getVariations, purchase, MOCK_CATALOG };
