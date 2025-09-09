const mongoose = require('mongoose');

const PrivateKeySchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  address: { type: String, required: true },
  privateKey: { type: String, required: true }
});

module.exports = mongoose.model('PrivateKey', PrivateKeySchema);

