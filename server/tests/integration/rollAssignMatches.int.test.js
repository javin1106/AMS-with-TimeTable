jest.mock("axios");
jest.mock("../../src/modules/attendanceModule/controllers/mlServiceClient");

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { buildTestApp } = require("../helpers/testApp");
const { connect, clearDatabase, disconnect } = require("../helpers/db");
const { authCookie } = require("../helpers/auth");
const ClusterMatch = require("../../src/models/attendanceModule/clusterMatch");

const BASE = "/api/v1/attendancemodule/roll-assign";
// Test-only batch name so cleanup can safely rm -rf just this folder under the
// real ground_truth dir (rollAssignController creates that dir at import time).
const TEST_BATCH = "BTECH_TESTMATCHES_2099";
const GROUND_TRUTH_DIR = path.join(__dirname, "..", "..", "ml-data", "ground_truth");
const BATCH_DIR = path.join(GROUND_TRUTH_DIR, TEST_BATCH);

// 1x1 JPEG — enough for the /\.(jpg|jpeg|png|webp)$/ scans under test.
const JPEG = Buffer.from("ffd8ffdb0043000806060706060806070708090907", "hex");

function makeFolder(name, files = []) {
  const dir = path.join(BATCH_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), JPEG);
  return dir;
}

let app;

beforeAll(async () => {
  await connect();
  app = buildTestApp();
});
beforeEach(() => {
  fs.rmSync(BATCH_DIR, { recursive: true, force: true });
  fs.mkdirSync(BATCH_DIR, { recursive: true });
});
afterEach(clearDatabase);
afterAll(async () => {
  await disconnect();
  fs.rmSync(BATCH_DIR, { recursive: true, force: true });
});

const getMatches = () =>
  request(app).get(`${BASE}/matches/${TEST_BATCH}`).set("Cookie", authCookie());

describe("GET /roll-assign/matches/:batch — adopting roll-number folders", () => {
  it("adopts a roll-number folder that has no DB record as approved", async () => {
    makeFolder("21CS001", ["a.jpg", "b.jpg"]);

    const res = await getMatches();
    expect(res.status).toBe(200);

    const record = res.body.matchMap["21CS001"];
    expect(record).toBeDefined();
    expect(record.approved).toBe(true);
    expect(record.status).toBe("approved");
    expect(record.rollNo).toBe("21CS001");
    expect(record.currentFolder).toBe("21CS001");
    expect(record.imageCount).toBe(2);
    expect(record._id).toBeTruthy();

    // Persisted, so the card has a stable _id for delete / edit-roll actions.
    const saved = await ClusterMatch.findOne({ batch: TEST_BATCH, folderName: "21CS001" });
    expect(saved.approved).toBe(true);
    expect(saved.rollNo).toBe("21CS001");
  });

  it("is idempotent — a second call creates no duplicate record", async () => {
    makeFolder("21CS002", ["a.jpg"]);

    await getMatches();
    await getMatches();

    expect(await ClusterMatch.countDocuments({ batch: TEST_BATCH })).toBe(1);
  });

  it("skips person_NNN folders, underscore-prefixed dirs and empty folders", async () => {
    makeFolder("person_001", ["a.jpg"]);
    makeFolder("_rejected", ["a.jpg"]);
    makeFolder("21CS003", []);

    const res = await getMatches();

    expect(res.body.matchMap).toEqual({});
    expect(await ClusterMatch.countDocuments({ batch: TEST_BATCH })).toBe(0);
  });

  it("does not re-adopt a folder already owned via currentFolder", async () => {
    // Normal approved shape: stable key stays person_NNN, folder on disk is the roll no.
    await ClusterMatch.create({
      batch: TEST_BATCH,
      folderName: "person_004",
      currentFolder: "21CS004",
      rollNo: "21CS004",
      status: "approved",
      approved: true,
    });
    makeFolder("21CS004", ["a.jpg"]);

    const res = await getMatches();

    expect(Object.keys(res.body.matchMap)).toEqual(["person_004"]);
    expect(await ClusterMatch.countDocuments({ batch: TEST_BATCH })).toBe(1);
  });
});

describe("POST /roll-assign/approve — merging into an existing roll-number folder", () => {
  const approve = (id, rollNo) =>
    request(app).post(`${BASE}/approve`).set("Cookie", authCookie()).send({ id, rollNo });

  it("merges into a folder owned by another record and leaves exactly one record", async () => {
    const existing = await ClusterMatch.create({
      batch: TEST_BATCH,
      folderName: "person_010",
      currentFolder: "21CS010",
      rollNo: "21CS010",
      status: "approved",
      approved: true,
    });
    makeFolder("21CS010", ["old.jpg"]);

    const incoming = await ClusterMatch.create({
      batch: TEST_BATCH,
      folderName: "person_011",
      currentFolder: "person_011",
      status: "matched",
      imageFiles: ["new.jpg"],
    });
    makeFolder("person_011", ["new.jpg"]);

    const res = await approve(incoming._id.toString(), "21CS010");
    expect(res.status).toBe(200);

    const records = await ClusterMatch.find({ batch: TEST_BATCH });
    expect(records).toHaveLength(1);
    expect(records[0]._id.toString()).toBe(existing._id.toString());
    expect(records[0].folderName).toBe("person_010");
    expect(records[0].approved).toBe(true);
    expect(records[0].imageCount).toBe(2);   // old.jpg + the copied-in photo
    expect(fs.existsSync(path.join(BATCH_DIR, "person_011"))).toBe(false);
  });

  it("keeps a folderName on every record when merging into an unowned folder", async () => {
    // The destination folder exists on disk with no record pointing at it —
    // the case that used to insert a folderName-less doc and then collide.
    makeFolder("21CS020", ["old.jpg"]);

    for (const folder of ["person_020", "person_021"]) {
      const rec = await ClusterMatch.create({
        batch: TEST_BATCH,
        folderName: folder,
        currentFolder: folder,
        status: "matched",
        imageFiles: [`${folder}.jpg`],
      });
      makeFolder(folder, [`${folder}.jpg`]);

      const res = await approve(rec._id.toString(), "21CS020");
      expect(res.status).toBe(200);
    }

    const records = await ClusterMatch.find({ batch: TEST_BATCH });
    expect(records).toHaveLength(1);
    expect(records[0].folderName).toBeTruthy();
    expect(records[0].rollNo).toBe("21CS020");
    expect(records[0].approved).toBe(true);

    // And the merged folder surfaces under Approved rather than being orphaned.
    const res = await getMatches();
    const approved = Object.values(res.body.matchMap).filter((r) => r.approved);
    expect(approved).toHaveLength(1);
    expect(approved[0].rollNo).toBe("21CS020");
  });
});
