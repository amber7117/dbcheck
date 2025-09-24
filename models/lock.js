const LockSchema = new mongoose.Schema({
  name: { type: String, unique: true },
  leaseUntil: { type: Date, index: true },
});
const Lock = mongoose.model('Lock', LockSchema);

async function withLock(name, ttlMs, fn) {
  const now = new Date();
  const lease = new Date(now.getTime() + ttlMs);
  const doc = await Lock.findOneAndUpdate(
    { name, $or: [{ leaseUntil: { $lt: now } }, { leaseUntil: { $exists: false } }] },
    { name, leaseUntil: lease },
    { upsert: true, new: true }
  );
  if (doc.leaseUntil.getTime() !== lease.getTime()) return false; // didn’t get lock
  try { await fn(); } finally {
    await Lock.updateOne({ name }, { leaseUntil: new Date(0) });
  }
  return true;
}
// usage:
setInterval(() => withLock('checkDeposits', 45_000, () => checkDeposits(bot)), 30_000);