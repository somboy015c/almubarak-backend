const mongoose = require('mongoose');

async function connectDB() {
  if (!process.env.MONGODB_URI) {
    throw new Error(
      'MONGODB_URI is not set. Add it to your .env (see .env.example) — see README for how to get a free MongoDB Atlas connection string.'
    );
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');
}

module.exports = connectDB;
