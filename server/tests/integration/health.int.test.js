jest.mock("axios");
jest.mock("../../src/modules/attendanceModule/controllers/mlServiceClient");
jest.mock("../../src/modules/attendanceModule/controllers/alertNotifier");

const request = require("supertest");
const mlServiceClient = require("../../src/modules/attendanceModule/controllers/mlServiceClient");
const alertNotifier = require("../../src/modules/attendanceModule/controllers/alertNotifier");
const { buildTestApp } = require("../helpers/testApp");
const { connect, clearDatabase, disconnect } = require("../helpers/db");
const { authCookie } = require("../helpers/auth");

const STATUS_URL = "/api/v1/attendancemodule/health/status";

let app;

beforeAll(async () => {
  await connect();
  app = buildTestApp();
});
afterEach(clearDatabase);
afterAll(disconnect);

const healthRouter = require("../../src/modules/attendanceModule/routes/healthRoutes");

// mlServiceClient.getTargetInfo is called unconditionally by getHealthStatus;
// give it a stable shape for every test in this file.
beforeEach(() => {
  if (healthRouter._resetState) {
    healthRouter._resetState();
  }
  mlServiceClient.getTargetInfo.mockReturnValue({
    kind: "local", label: "Local ML service", host: "localhost", port: "8500", display: "localhost:8500",
  });
  jest.clearAllMocks();
});

// healthRoutes.js tracks prevMlStatus as module-level state (not per-request),
// so these tests are intentionally order-dependent within this file — Jest
// runs tests in one file sequentially, so this is safe, but don't reorder.
describe("GET /health/status", () => {
  it("reports database online (memory server connected) and ERP not_configured", async () => {
    mlServiceClient.healthCheck.mockResolvedValue({ status: "ok" });
    const res = await request(app).get(STATUS_URL).set("Cookie", authCookie());
    expect(res.status).toBe(200);
    expect(res.body.services.database.status).toBe("online");
    expect(res.body.services.erp.status).toBe("not_configured");
  });

  it("reports ml online when mlClient.healthCheck resolves", async () => {
    mlServiceClient.healthCheck.mockResolvedValue({ status: "ok", students_enrolled: 42 });
    const res = await request(app).get(STATUS_URL).set("Cookie", authCookie());
    expect(res.status).toBe(200);
    expect(res.body.services.ml.status).toBe("online");
    expect(res.body.services.ml.studentsEnrolled).toBe(42);
  });

  it("reports ml offline and fires notifyServerDown after 3 consecutive failures", async () => {
    // Previous test left module state at prevMlStatus="online"
    mlServiceClient.healthCheck.mockRejectedValue(new Error("connection refused"));
    
    // 1st failure
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    let res = await request(app).get(STATUS_URL).set("Cookie", authCookie());
    expect(res.status).toBe(200);
    expect(res.body.services.ml.status).toBe("offline");
    expect(alertNotifier.notifyServerDown).not.toHaveBeenCalled();

    // 2nd failure (advance time by 2s to bypass throttle)
    jest.spyOn(Date, "now").mockReturnValue(now + 2000);
    res = await request(app).get(STATUS_URL).set("Cookie", authCookie());
    expect(res.body.services.ml.status).toBe("offline");
    expect(alertNotifier.notifyServerDown).not.toHaveBeenCalled();

    // 3rd failure (advance time by another 2s)
    jest.spyOn(Date, "now").mockReturnValue(now + 4000);
    res = await request(app).get(STATUS_URL).set("Cookie", authCookie());
    expect(res.body.services.ml.status).toBe("offline");
    expect(alertNotifier.notifyServerDown).toHaveBeenCalledTimes(1);
    expect(alertNotifier.notifyServerDown).toHaveBeenCalledWith("ML Service", expect.any(String));
    
    jest.spyOn(Date, "now").mockRestore();
  });

  it("does not re-fire notifyServerDown while ml stays offline", async () => {
    // Runs after the previous test, so healthRoutes' module-level prevMlStatus
    // is already "offline" — neither call here is a fresh online->offline
    // transition, so notifyServerDown must not fire at all.
    mlServiceClient.healthCheck.mockRejectedValue(new Error("still down"));
    await request(app).get(STATUS_URL).set("Cookie", authCookie());
    await request(app).get(STATUS_URL).set("Cookie", authCookie());
    expect(alertNotifier.notifyServerDown).not.toHaveBeenCalled();
  });
});
