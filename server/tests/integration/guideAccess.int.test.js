// Access control on the developer guide.
//
// This endpoint used to serve on GET with no authentication at all, and accept
// PUT from any account that merely held a valid cookie. What it serves is the
// internal map of the system — every backend route including ML process
// control and the camera registry, the on-disk ml-data layout, and the shape of
// the server's configuration — so reading it is as sensitive as writing it.
// Both verbs are administrators only, and the read side is the half most
// worth pinning: it is the one that was silently open.
const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");

const { connect, clearDatabase, disconnect } = require("../helpers/db");
const { authCookie } = require("../helpers/auth");

const BASE = "/api/v1/guide";

let app;

beforeAll(async () => {
  await connect();
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(BASE, require("../../src/modules/guideModule/routes/index"));
});

afterEach(async () => clearDatabase());
afterAll(async () => disconnect());

const tabs = [{ id: "setup", title: "Setup", content: "<p>hi</p>", order: 0 }];

describe("GET /api/v1/guide", () => {
  it("refuses an anonymous reader", async () => {
    const res = await request(app).get(BASE);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/MONGO_URL|JWT_SECRET/);
  });

  it("refuses a student", async () => {
    const res = await request(app).get(BASE).set("Cookie", authCookie(["STUDENT"]));
    expect(res.status).toBe(403);
    expect(res.body.tabs).toBeUndefined();
  });

  it("refuses faculty", async () => {
    const res = await request(app).get(BASE).set("Cookie", authCookie(["FACULTY"]));
    expect(res.status).toBe(403);
  });

  it("serves an admin", async () => {
    const res = await request(app).get(BASE).set("Cookie", authCookie(["admin"]));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tabs)).toBe(true);
    expect(res.body.tabs.length).toBeGreaterThan(0);
  });

  it("serves an iams-admin", async () => {
    const res = await request(app).get(BASE).set("Cookie", authCookie(["iams-admin"]));
    expect(res.status).toBe(200);
  });
});

describe("PUT /api/v1/guide", () => {
  it("refuses an anonymous writer", async () => {
    const res = await request(app).put(BASE).send({ tabs });
    expect(res.status).toBe(401);
  });

  it("refuses a student — a logged-in account is not an authorised one", async () => {
    const res = await request(app)
      .put(BASE)
      .set("Cookie", authCookie(["STUDENT"]))
      .send({ tabs: [{ id: "x", title: "Owned", content: "<p>defaced</p>", order: 0 }] });
    expect(res.status).toBe(403);

    // And nothing was written: the next admin read still shows the defaults.
    const after = await request(app).get(BASE).set("Cookie", authCookie(["admin"]));
    expect(after.body.tabs.some((tab) => tab.title === "Owned")).toBe(false);
  });

  it("accepts an admin", async () => {
    const res = await request(app)
      .put(BASE)
      .set("Cookie", authCookie(["admin"]))
      .send({ tabs });
    expect(res.status).toBe(200);
    expect(res.body.tabs[0].title).toBe("Setup");
  });
});
