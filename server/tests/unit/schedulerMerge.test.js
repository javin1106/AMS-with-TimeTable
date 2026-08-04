const { mergeRunResults } = require("../../src/modules/attendanceModule/controllers/schedulerController");

function run(attendance) {
  return { attendance };
}

describe("mergeRunResults", () => {
  it("minRunsPresent=1: present if present in at least one run", () => {
    const runs = [
      run({ R1: { status: "absent", avg_confidence: 0.5 } }),
      run({ R1: { status: "present", avg_confidence: 0.9 } }),
    ];
    const merged = mergeRunResults(runs, 1);
    expect(merged.attendance.R1.status).toBe("present");
    expect(merged.summary.present).toBe(1);
  });

  it("minRunsPresent=2 (of 2): requires present in every run", () => {
    const runs = [
      run({ R1: { status: "present", avg_confidence: 0.5 } }),
      run({ R1: { status: "absent", avg_confidence: 0.9 } }),
    ];
    const merged = mergeRunResults(runs, 2);
    expect(merged.attendance.R1.status).toBe("absent");
  });

  it("minRunsPresent=2 (of 2): present when present in every run", () => {
    const runs = [
      run({ R1: { status: "present", avg_confidence: 0.5 } }),
      run({ R1: { status: "present", avg_confidence: 0.9 } }),
    ];
    const merged = mergeRunResults(runs, 2);
    expect(merged.attendance.R1.status).toBe("present");
  });

  it("minRunsPresent=2 (of 3): present when at least 2 of the runs say present", () => {
    const runs = [
      run({ R1: { status: "present", avg_confidence: 0.5 } }),
      run({ R1: { status: "present", avg_confidence: 0.6 } }),
      run({ R1: { status: "absent", avg_confidence: 0.9 } }),
    ];
    const merged = mergeRunResults(runs, 2);
    expect(merged.attendance.R1.status).toBe("present");
  });

  it("minRunsPresent=2 (of 3): absent when only 1 run says present", () => {
    const runs = [
      run({ R1: { status: "present", avg_confidence: 0.5 } }),
      run({ R1: { status: "absent", avg_confidence: 0.6 } }),
      run({ R1: { status: "absent", avg_confidence: 0.9 } }),
    ];
    const merged = mergeRunResults(runs, 2);
    expect(merged.attendance.R1.status).toBe("absent");
  });

  it("falls back to review (not absent) when a non-present run reported review", () => {
    const runs = [
      run({ R1: { status: "review", avg_confidence: 0.3 } }),
      run({ R1: { status: "absent", avg_confidence: 0.2 } }),
    ];
    const merged = mergeRunResults(runs, 2);
    expect(merged.attendance.R1.status).toBe("review");
  });

  it("falls back to absent when no run reported review or present", () => {
    const runs = [
      run({ R1: { status: "absent", avg_confidence: 0.2 } }),
      run({ R1: { status: "absent", avg_confidence: 0.1 } }),
    ];
    const merged = mergeRunResults(runs, 1);
    expect(merged.attendance.R1.status).toBe("absent");
  });

  it("keeps the fields of the highest avg_confidence entry", () => {
    const runs = [
      run({ R1: { status: "present", avg_confidence: 0.3, confidence_zone: "low" } }),
      run({ R1: { status: "present", avg_confidence: 0.95, confidence_zone: "high" } }),
    ];
    const merged = mergeRunResults(runs, 1);
    expect(merged.attendance.R1.avg_confidence).toBe(0.95);
    expect(merged.attendance.R1.confidence_zone).toBe("high");
  });

  it("recomputes summary counts from the merged attendance map", () => {
    const runs = [
      run({
        R1: { status: "present", avg_confidence: 0.9 },
        R2: { status: "absent", avg_confidence: 0.1 },
        R3: { status: "review", avg_confidence: 0.2 },
      }),
    ];
    const merged = mergeRunResults(runs, 1);
    expect(merged.summary).toEqual({ present: 1, absent: 1, review: 1 });
  });
});
