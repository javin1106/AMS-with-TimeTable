const LmClass = require("../models/lmClass");
const game = require("../services/gamification");

/**
 * A student's record across every class they have ever been in, by session.
 *
 * Not a leaderboard and not a transcript. It is the answer to "what have I
 * actually done here", which no per-class page can give — points and badges are
 * earned per class by design, so the only place a whole career adds up is here.
 *
 * Class *names* are resolved in one query rather than being denormalised onto
 * every ledger row: unlike the session, a class can be renamed, and a profile
 * showing what a class used to be called would be a small lie that compounds.
 */
exports.getMyProfile = async (req, res) => {
  const profile = await game.profileFor(req.lmUser.id);

  const classIds = [
    ...new Set(
      profile.sessions.flatMap((entry) =>
        entry.classes.map((row) => row.classId).filter(Boolean).map(String),
      ),
    ),
  ];

  const classes = await LmClass.find({ _id: { $in: classIds } })
    .select("name subject section coverColor session")
    .lean();
  const byId = new Map(classes.map((klass) => [String(klass._id), klass]));

  const named = profile.sessions.map((entry) => ({
    ...entry,
    classes: entry.classes.map((row) => {
      const klass = row.classId ? byId.get(String(row.classId)) : null;
      return {
        ...row,
        // A class that has since been deleted still has points against it; the
        // total would be wrong without it, so it is shown rather than dropped.
        name: klass?.name || (row.classId ? "A class that no longer exists" : "Outside any class"),
        subject: klass?.subject || "",
        coverColor: klass?.coverColor || "#718096",
      };
    }),
  }));

  return res.json({
    ...profile,
    sessions: named,
    catalogue: Object.keys(game.BADGES).map((id) => game.describeBadge(id)),
  });
};
