const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const { connect, clearDatabase, disconnect } = require("../helpers/db");
const { authCookie } = require("../helpers/auth");
const User = require("../../src/models/usermanagement/user");
const TimeTable = require("../../src/models/timetable");

let app;

beforeAll(async () => {
  await connect();
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    "/user/getuser",
    require("../../src/modules/usermanagement/routes/user"),
  );
});
afterEach(clearDatabase);
afterAll(disconnect);

const seedDepartments = () => TimeTable.create([
  { name: "ece", dept: "ECE", session: "2026-27" },
  { name: "vlsi", dept: "VLSI", session: "2026-27" },
]);

describe("PUT /user/getuser/department", () => {
  it("stores a primary dashboard department and multiple GT / Roll departments", async () => {
    await seedDepartments();
    const user = await User.create({
      role: ["iams-dept-admin"],
      password: "x",
      email: ["multi@x.com"],
      dept: "ECE",
    });

    const response = await request(app)
      .put("/user/getuser/department")
      .set("Cookie", authCookie(["admin"]))
      .send({
        userId: user._id.toString(),
        dept: "ECE",
        attendanceDepartments: ["VLSI", "ECE", "vlsi"],
      });

    expect(response.status).toBe(200);
    expect(response.body.user.dept).toBe("ECE");
    expect(response.body.user.attendanceDepartments).toEqual(["ECE", "VLSI"]);
    expect(response.body.user.password).toBeUndefined();

    const saved = await User.findById(user._id).lean();
    expect(saved.attendanceDepartments).toEqual(["ECE", "VLSI"]);
  });

  it("rejects a department that is not present in the timetable", async () => {
    await seedDepartments();
    const user = await User.create({
      role: ["iams-dept-admin"],
      password: "x",
      email: ["multi@x.com"],
      dept: "ECE",
      attendanceDepartments: ["ECE"],
    });

    const response = await request(app)
      .put("/user/getuser/department")
      .set("Cookie", authCookie(["admin"]))
      .send({
        userId: user._id.toString(),
        dept: "ECE",
        attendanceDepartments: ["ECE", "CSE"],
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("CSE");

    const saved = await User.findById(user._id).lean();
    expect(saved.attendanceDepartments).toEqual(["ECE"]);
  });

  it("lets an iLEED admin update GT / Roll access without changing the primary department", async () => {
    await seedDepartments();
    const user = await User.create({
      role: ["iams-dept-admin"],
      password: "x",
      email: ["multi@x.com"],
      dept: "ECE",
      attendanceDepartments: ["ECE"],
    });

    const accessUpdate = await request(app)
      .put("/user/getuser/department")
      .set("Cookie", authCookie(["iams-admin"]))
      .send({
        userId: user._id.toString(),
        dept: "ECE",
        attendanceDepartments: ["ECE", "VLSI"],
      });
    expect(accessUpdate.status).toBe(200);
    expect(accessUpdate.body.user.attendanceDepartments).toEqual(["ECE", "VLSI"]);

    const primaryChange = await request(app)
      .put("/user/getuser/department")
      .set("Cookie", authCookie(["iams-admin"]))
      .send({
        userId: user._id.toString(),
        dept: "VLSI",
        attendanceDepartments: ["VLSI"],
      });
    expect(primaryChange.status).toBe(403);

    const saved = await User.findById(user._id).lean();
    expect(saved.dept).toBe("ECE");
    expect(saved.attendanceDepartments).toEqual(["ECE", "VLSI"]);
  });
});
