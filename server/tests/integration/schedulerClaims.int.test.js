// Claiming and resuming scheduler work.
//
// These cover the two failures that made a server restart lose a period: the
// once-per-period guard living in process memory, and "a report exists" being
// read as "the period finished".

const { connect, clearDatabase, disconnect } = require("../helpers/db");
const {
  claimSchedulerWork,
  heartbeatSchedulerWork,
  releaseSchedulerWork,
  beginAttempt,
  updateAttempt,
} = require("../../src/modules/attendanceModule/controllers/schedulerClaims");
const SchedulerLedger = require("../../src/models/attendanceModule/schedulerLedger");
const {
  nextCheckIndex,
} = require("../../src/modules/attendanceModule/controllers/autoAttendanceScheduler");

beforeAll(connect);
afterEach(clearDatabase);
afterAll(disconnect);

const KEY = { date: "2026-08-07", periodKey: "period3", room: "LH-101" };

describe("claimSchedulerWork", () => {
  it("grants the first caller and refuses the second", async () => {
    const first = await claimSchedulerWork({ ...KEY, targetRuns: 3 });
    const second = await claimSchedulerWork({ ...KEY, targetRuns: 3 });

    expect(first.claimed).toBe(true);
    expect(first.resumed).toBe(false);
    expect(second.claimed).toBe(false);
    expect(second.reason).toBe("held by a live run");

    expect(await SchedulerLedger.countDocuments(KEY)).toBe(1);
  });

  it("normalises room case, so one period cannot be claimed twice", async () => {
    const upper = await claimSchedulerWork({ ...KEY, room: "LH-101" });
    const lower = await claimSchedulerWork({ ...KEY, room: "lh-101" });

    expect(upper.claimed).toBe(true);
    expect(lower.claimed).toBe(false);
  });

  it("refuses work already closed for the day", async () => {
    await claimSchedulerWork(KEY);
    await releaseSchedulerWork({ ...KEY, state: "done", checksSaved: 3 });

    const again = await claimSchedulerWork(KEY);
    expect(again.claimed).toBe(false);
    expect(again.reason).toBe("already done");
  });

  it("lets a later process take over a claim whose holder died", async () => {
    await claimSchedulerWork(KEY);
    // The holder crashed: nothing beat the claim again. Simulate by ageing the
    // heartbeat past the staleness window.
    await SchedulerLedger.updateOne(
      { ...KEY, task: "run" },
      { $set: { heartbeatAt: new Date(Date.now() - 30 * 60 * 1000) } },
    );

    const takeover = await claimSchedulerWork(KEY);
    expect(takeover.claimed).toBe(true);
    expect(takeover.resumed).toBe(true);
    expect(takeover.doc.resumedCount).toBe(1);
  });

  it("does not steal a claim that is still beating", async () => {
    await claimSchedulerWork(KEY);
    await heartbeatSchedulerWork({ ...KEY, checksSaved: 1 });

    const takeover = await claimSchedulerWork(KEY);
    expect(takeover.claimed).toBe(false);

    const row = await SchedulerLedger.findOne({ ...KEY, task: "run" }).lean();
    expect(row.checksSaved).toBe(1);
  });

  it("hands an unfinished claim straight back, without waiting out the window", async () => {
    await claimSchedulerWork(KEY);
    // A run that failed gives the period back so the next tick can retry it
    // inside the same period — waiting out the staleness window would usually
    // mean waiting past the end of the class.
    await releaseSchedulerWork({ ...KEY, state: "claimed", error: "camera offline" });

    const retry = await claimSchedulerWork(KEY);
    expect(retry.claimed).toBe(true);
  });

  it("stops retrying a room that keeps failing", async () => {
    for (let i = 0; i < 3; i++) {
      const claim = await claimSchedulerWork(KEY);
      expect(claim.claimed).toBe(true);
      await beginAttempt(KEY, { trigger: "cron" });
      await releaseSchedulerWork({ ...KEY, state: "claimed", error: "camera offline" });
    }

    const row = await SchedulerLedger.findOne({ ...KEY, task: "run" }).lean();
    expect(row.state).toBe("interrupted");

    const fourth = await claimSchedulerWork(KEY);
    expect(fourth.claimed).toBe(false);
  });

  it("keeps a manual run on its own row, so it neither satisfies nor blocks the cron", async () => {
    await beginAttempt({ ...KEY, task: "manualRun" }, { trigger: "manual" });

    const cronClaim = await claimSchedulerWork(KEY);
    expect(cronClaim.claimed).toBe(true);
    expect(await SchedulerLedger.countDocuments({ date: KEY.date })).toBe(2);
  });
});

describe("attempt recording", () => {
  it("stores the step trail and the outcome for later reading", async () => {
    await claimSchedulerWork(KEY);
    const idx = await beginAttempt(KEY, { trigger: "cron", targetRuns: 2 });
    expect(idx).toBe(0);

    await updateAttempt(KEY, idx, {
      steps: [
        { at: new Date(), msg: "Class resolved: BTECH_CSE_2023 — DBMS", warn: false },
        { at: new Date(), msg: "No active camera for room=LH-101 — skipping", warn: true },
      ],
      status: "skipped",
      reason: "No active camera for room=LH-101",
      finishedAt: new Date(),
    });

    const row = await SchedulerLedger.findOne({ ...KEY, task: "run" }).lean();
    expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0].status).toBe("skipped");
    expect(row.attempts[0].steps).toHaveLength(2);
    expect(row.attempts[0].steps[1].warn).toBe(true);
  });

  it("appends a second attempt rather than overwriting the first", async () => {
    await claimSchedulerWork(KEY);
    const first = await beginAttempt(KEY, { trigger: "cron" });
    await updateAttempt(KEY, first, { status: "error", reason: "ML timeout" });
    const second = await beginAttempt(KEY, { trigger: "resume" });

    expect(second).toBe(1);
    const row = await SchedulerLedger.findOne({ ...KEY, task: "run" }).lean();
    expect(row.attempts.map((a) => a.trigger)).toEqual(["cron", "resume"]);
    expect(row.attempts[0].status).toBe("error");
  });
});

describe("nextCheckIndex", () => {
  it("starts at 1 for a period that has never run", () => {
    expect(nextCheckIndex([], "period3")).toBe(1);
  });

  it("continues past the checks a crashed run already saved", () => {
    const saved = [{ slot: "period3-check1" }, { slot: "period3-check2" }];
    expect(nextCheckIndex(saved, "period3")).toBe(3);
  });

  it("never lands on top of rows it cannot parse", () => {
    // The live-session path writes `check-N` into the same report; a resume
    // must still start past everything already there.
    const saved = [{ slot: "check-1" }, { slot: "check-2" }];
    expect(nextCheckIndex(saved, "period3")).toBe(3);
  });

  it("ignores rows belonging to a different slot", () => {
    const saved = [{ slot: "period4-check7" }];
    expect(nextCheckIndex(saved, "period3")).toBe(2);
  });
});
