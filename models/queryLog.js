const mongoose = require('mongoose');

const QueryLogSchema = new mongoose.Schema({
  userId: Number,
  query: String,
  results: Number,
  success: Boolean,
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('QueryLog', QueryLogSchema);

