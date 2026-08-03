jest.mock("axios");
jest.mock("../../src/modules/attendanceModule/controllers/mlServiceClient");

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { buildTestApp } = require("../helpers/testApp");
const { connect, clearDatabase, disconnect } = require("../helpers/db");
const { authCookie } = require("../helpers/auth");
const ClusterMatch = require("../../src/models/attendanceModule/clusterMatch");

const GT_BASE = "/api/v1/attendancemodule/ground-truth";
const FLAG_BASE = "/api/v1/attendancemodule/flags";
const TEST_BATCH = "BTECH_TESTPHOTODEL_2099";
const GROUND_TRUTH_DIR = path.join(__dirname, "..", "..", "ml-data", "ground_truth");
const BATCH_DIR = path.join(GROUND_TRUTH_DIR, TEST_BATCH);

let app;

function seedStudent(folder, info) {
  const dir = path.join(BATCH_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [...(info.embedding_files || []), ...(info.backup_files || [])]) {
    fs.writeFileSync(path.join(dir, f), Buffer.from("fake-jpeg-bytes"));
  }
  fs.writeFileSync(path.join(dir, "_info.json"), JSON.stringify(info, null, 2));
  return dir;
}

const readInfo = (folder) =>
  JSON.parse(fs.readFileSync(path.join(BATCH_DIR, folder, "_info.json"), "utf8"));

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

// The reconciliation is shared, so each route is checked against the same
// expectations rather than each growing its own partial cleanup again.
describe.each([
  [
    "DELETE /ground-truth/photo/:batch/:rollNo/:filename",
    (folder, filename) =>
      request(app)
        .delete(`${GT_BASE}/photo/${TEST_BATCH}/${folder}/${filename}`)
        .set("Cookie", authCookie()),
  ],
  [
    "DELETE /flags/cluster-photo/:batch/:folder/:filename",
    (folder, filename) =>
      request(app)
        .delete(`${FLAG_BASE}/cluster-photo/${TEST_BATCH}/${folder}/${filename}`)
        .set("Cookie", authCookie()),
  ],
])("%s", (_label, del) => {
  it("drops the photo from every _info.json list and from scores", async () => {
    seedStudent("21CS500", {
      embedding_files: ["a.jpg", "b.jpg"],
      backup_files: ["c.jpg"],
      approved_files: ["a.jpg", "b.jpg", "c.jpg"],
      scores: { "a.jpg": 0.9, "b.jpg": 0.8, "c.jpg": 0.7 },
      mean_embedding: [0.1, 0.2, 0.3],
    });

    const res = await del("21CS500", "c.jpg");
    expect(res.status).toBe(200);

    expect(fs.existsSync(path.join(BATCH_DIR, "21CS500", "c.jpg"))).toBe(false);
    const info = readInfo("21CS500");
    expect(info.embedding_files).toEqual(["a.jpg", "b.jpg"]);
    expect(info.backup_files).toEqual([]);
    expect(info.approved_files).toEqual(["a.jpg", "b.jpg"]);
    expect(info.scores["c.jpg"]).toBeUndefined();
    // c.jpg was a backup, not an embedding photo — the cached vector still stands.
    expect(info.mean_embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("drops the cached embedding vectors when the last embedding photo goes", async () => {
    seedStudent("21CS501", {
      embedding_files: ["only.jpg"],
      backup_files: [],
      approved_files: ["only.jpg"],
      scores: { "only.jpg": 0.9 },
      mean_embedding: [0.1, 0.2, 0.3],
      top_k_embeddings: [[0.1, 0.2, 0.3]],
      adaface_mean_embedding: [0.4, 0.5],
      adaface_top_k_embeddings: [[0.4, 0.5]],
    });

    const res = await del("21CS501", "only.jpg");
    expect(res.status).toBe(200);

    const info = readInfo("21CS501");
    expect(info.embedding_files).toEqual([]);
    expect(info.mean_embedding).toBeUndefined();
    expect(info.top_k_embeddings).toBeUndefined();
    expect(info.adaface_mean_embedding).toBeUndefined();
    expect(info.adaface_top_k_embeddings).toBeUndefined();
  });

  it("leaves a folder with no _info.json alone", async () => {
    const dir = path.join(BATCH_DIR, "21CS502");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.jpg"), Buffer.from("fake-jpeg-bytes"));

    const res = await del("21CS502", "a.jpg");
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(dir, "a.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "_info.json"))).toBe(false);
  });
});

describe("DELETE /flags/cluster-photo — ClusterMatch sync", () => {
  it("updates the record that owns the folder via currentFolder", async () => {
    // Approved shape: stable key stays person_NNN, folder on disk is the roll no.
    await ClusterMatch.create({
      batch: TEST_BATCH,
      folderName: "person_600",
      currentFolder: "21CS600",
      rollNo: "21CS600",
      status: "approved",
      approved: true,
      imageFiles: ["a.jpg", "b.jpg"],
      previewFiles: ["a.jpg", "b.jpg"],
      embeddingFiles: ["a.jpg", "b.jpg"],
      imageCount: 2,
    });
    seedStudent("21CS600", {
      embedding_files: ["a.jpg", "b.jpg"],
      approved_files: ["a.jpg", "b.jpg"],
    });

    const res = await request(app)
      .delete(`${FLAG_BASE}/cluster-photo/${TEST_BATCH}/21CS600/b.jpg`)
      .set("Cookie", authCookie());
    expect(res.status).toBe(200);

    const doc = await ClusterMatch.findOne({ batch: TEST_BATCH, folderName: "person_600" });
    expect(doc.imageFiles).toEqual(["a.jpg"]);
    expect(doc.previewFiles).toEqual(["a.jpg"]);
    expect(doc.embeddingFiles).toEqual(["a.jpg"]);
    expect(doc.imageCount).toBe(1);
  });
});
