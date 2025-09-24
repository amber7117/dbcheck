const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  points: { type: Number, default: 0 },
  invitedBy: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now },
  isAdmin: { type: Boolean, default: false },
  lastCheckin: { type: Date },
  subscribed: { type: Boolean, default: false },
  subscriptionType: { type: String, enum: ['monthly', 'quarterly', 'permanent', null], default: null },
  subscriptionExpiresAt: { type: Date },
  isActive: { type: Boolean, default: true }
});

module.exports = mongoose.model('User', UserSchema);
