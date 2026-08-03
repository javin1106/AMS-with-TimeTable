const LmNotification = require("../models/lmNotification");

exports.list = async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const filter = { userId: req.lmUser.id };
  if (req.query.unread === "true") filter.read = false;

  const [items, unreadCount] = await Promise.all([
    LmNotification.find(filter).sort({ created_at: -1 }).limit(limit).lean(),
    LmNotification.countDocuments({ userId: req.lmUser.id, read: false }),
  ]);

  return res.json({ items, unreadCount });
};

exports.markRead = async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : null;
  const filter = { userId: req.lmUser.id, read: false };
  if (ids) filter._id = { $in: ids };

  const result = await LmNotification.updateMany(filter, {
    $set: { read: true, readAt: new Date() },
  });
  return res.json({ updated: result.modifiedCount });
};

exports.remove = async (req, res) => {
  await LmNotification.deleteOne({ _id: req.params.notificationId, userId: req.lmUser.id });
  return res.json({ deleted: true });
};

exports.clearAll = async (req, res) => {
  const result = await LmNotification.deleteMany({ userId: req.lmUser.id, read: true });
  return res.json({ deleted: result.deletedCount });
};
