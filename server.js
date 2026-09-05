require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const serviceRoutes = require('./routes/services');
const transactionRoutes = require('./routes/transactions');
const adminRoutes = require('./routes/admin');

const app = express();

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
app.use('/api/auth', authLimiter, authRoutes);

app.use('/api/wallet', walletRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/admin', adminRoutes);

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
app.listen(PORT, () => {
  console.log(`Almubarak VTU API running on port ${PORT} (${process.env.PROVIDER_MODE || 'mock'} mode)`);
});
