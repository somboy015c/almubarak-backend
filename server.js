require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');

const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const serviceRoutes = require('./routes/services');
const transactionRoutes = require('./routes/transactions');
const adminRoutes = require('./routes/admin');
const securityRoutes = require('./routes/security');
const transferRoutes = require('./routes/transfer');
const withdrawalRoutes = require('./routes/withdrawal');
const airtimeToCashRoutes = require('./routes/airtime-to-cash');
const webhookRoutes = require('./routes/webhooks');
const publicRoutes = require('./routes/public');
const notificationRoutes = require('./routes/notifications');
const { settleAllPending } = require('./services/settle');
const { requireService } = require('./middleware/services');
const provider = require('./services/arrifqubundle');
const { alertAdmin, money } = require('./services/notify');

const app = express();

// Render (and most hosts) sit behind a proxy; needed for correct per-IP rate limiting.
app.set('trust proxy', 1);

const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow tools like curl/Postman (no origin) and any listed origin.
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error('Not allowed by CORS'));
    }
  })
);

app.use(express.json());

// Basic protection against brute-forcing login/register
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
// Stricter cap on endpoints that send email, to stop inbox spamming / Resend quota abuse
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, message: { error: 'Too many requests. Please try again in a few minutes.' } });
app.use(['/api/auth/forgot-password', '/api/auth/resend-verification'], emailLimiter);
app.use('/api/auth', authLimiter, authRoutes);

app.use('/api/webhooks', webhookRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/transfer', requireService('transfer'), transferRoutes);
app.use('/api/withdrawal', requireService('withdrawal'), withdrawalRoutes);
app.use('/api/airtime-to-cash', requireService('airtime-to-cash'), airtimeToCashRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mode: process.env.PROVIDER_MODE || 'mock' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Elmubarak VTU API running on port ${PORT} (${process.env.PROVIDER_MODE || 'mock'} mode)`);
    });
    // The provider has no webhook, so check slow orders every 2 minutes.
    setInterval(() => settleAllPending().catch((e) => console.error('Settle sweep failed:', e.message)), 2 * 60 * 1000);

    // Email the admins when the provider wallet runs low (checked every 20 minutes, emailed at most every 6 hours).
    if (process.env.PROVIDER_MODE === 'live') {
      const watchBalance = async () => {
        const r = await provider.getBalance();
        const threshold = Number(process.env.PROVIDER_LOW_BALANCE_ALERT || 10000);
        if (r.ok && r.balance < threshold) {
          alertAdmin({ key: 'provider-low-balance', level: 'critical', title: `Provider wallet is low: ${money(r.balance)}`, message: `Your Arrifqubundle wallet is below ${money(threshold)}. Top it up now, or customer orders will start failing.`, rows: [['Balance', money(r.balance)], ['Alert level', money(threshold)]], throttleMs: 6 * 60 * 60 * 1000 });
        } else if (!r.ok) {
          alertAdmin({ key: 'provider-balance-error', level: 'warning', title: 'Could not read the provider balance', message: r.message || 'The provider did not answer.', throttleMs: 6 * 60 * 60 * 1000 });
        }
      };
      setTimeout(() => watchBalance().catch(() => {}), 60 * 1000);
      setInterval(() => watchBalance().catch(() => {}), 20 * 60 * 1000);
    }
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });
