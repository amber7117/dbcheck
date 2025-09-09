const mongoose = require('mongoose');

const DeveloperSchema = new mongoose.Schema({
  name: { type: String, required: true },
  apiKey: { type: String, required: true, unique: true },
  points: { type: Number, default: 0 },
});

module.exports = mongoose.model('Developer', DeveloperSchema);
