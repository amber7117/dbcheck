const User = require('./models/user');
const QueryLog = require('./models/queryLog');

async function isAdmin(userId) {
  const user = await User.findOne({ userId });
  return user && user.isAdmin;
}

async function getUserInfo(targetUserId) {
  return User.findOne({ userId: targetUserId });
}

async function addPoints(targetUserId, points) {
  return User.findOneAndUpdate({ userId: targetUserId }, { $inc: { points: parseInt(points, 10) } }, { new: true });
}

async function checkPoints(targetUserId) {
  const user = await User.findOne({ userId: targetUserId });
  return user ? user.points : null;
}

async function getUserHistory(targetUserId) {
  return QueryLog.find({ userId: targetUserId }).sort({ timestamp: -1 }).limit(50);
}

async function listAllUsers() {
  return User.find({}).sort({ userId: 1 });
}

module.exports = {
  isAdmin,
  getUserInfo,
  addPoints,
  checkPoints,
  getUserHistory,
  listAllUsers,
};
