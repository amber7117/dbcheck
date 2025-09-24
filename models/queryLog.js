const mongoose = require('mongoose');

const QueryLogSchema = new mongoose.Schema({
  userId: Number,
  query: String,
  resultCount: Number,
  resultText: String, // To store the full result text
  success: Boolean,
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('QueryLog', QueryLogSchema);
