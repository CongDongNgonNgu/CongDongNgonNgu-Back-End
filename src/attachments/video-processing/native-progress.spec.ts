import {
  NativeProgressClock,
  parseNativeProgress,
  advanceNativeProgress,
} from "./native-progress";
describe("closed bounded native stage timing", () => {
  it("records only completed stage durations and relative monotonic elapsed time", () => {
    let now = 1000;
    const progress = new NativeProgressClock(() => now);
    now = 1025;
    progress.enter("VERIFY_TIME");
    now = 1070;
    progress.enter("VERIFY_DISTRIBUTION");
    now = 1090;
    expect(progress.snapshot()).toEqual({
      stage: "VERIFY_DISTRIBUTION",
      elapsedMs: 90,
      completed: [
        { stage: "BOOT", elapsedMs: 25 },
        { stage: "VERIFY_TIME", elapsedMs: 45 },
      ],
    });
  });
  it("rejects invalid stages/clocks and omits expired telemetry without changing timeout classification", () => {
    let now = 0;
    const p = new NativeProgressClock(() => now);
    now = 1;
    p.enter("VERIFY_TIME");
    expect(() => p.enter("SECRET_PATH" as "BOOT")).toThrow();
    expect(() => p.enter("BOOT")).toThrow();
    now = 0;
    expect(() => p.snapshot()).toThrow();
    now = 15001;
    expect(() => p.enter("RESULT")).not.toThrow();
    expect(p.snapshot()).toBeNull();
  });
  it("scrubs arbitrary fields, nonfinite values, duplicate stages and oversized progress", () => {
    const valid = {
      stage: "SOURCE_DECODE",
      elapsedMs: 10,
      completed: [{ stage: "BOOT", elapsedMs: 1 }],
    };
    expect(parseNativeProgress(valid)).toEqual(valid);
    for (const bad of [
      { ...valid, path: "PRIVATE" },
      { ...valid, stage: "PRIVATE_URL" },
      { ...valid, elapsedMs: Infinity },
      { ...valid, elapsedMs: 15001 },
      { ...valid, completed: [{ stage: "BOOT", elapsedMs: -1 }] },
      {
        ...valid,
        completed: [
          { stage: "BOOT", elapsedMs: 1 },
          { stage: "BOOT", elapsedMs: 2 },
        ],
      },
      { ...valid, completed: Array(21).fill({ stage: "BOOT", elapsedMs: 1 }) },
    ])
      expect(parseNativeProgress(bad)).toBeNull();
  });
  it("rejects backwards or rewritten history while allowing consistent transitions", () => {
    const first = {
      stage: "VERIFY_TIME",
      elapsedMs: 10,
      completed: [{ stage: "BOOT", elapsedMs: 2 }],
    } as const;
    const next = {
      stage: "VERIFY_DISTRIBUTION",
      elapsedMs: 15,
      completed: [
        { stage: "BOOT", elapsedMs: 2 },
        { stage: "VERIFY_TIME", elapsedMs: 10 },
      ],
    } as const;
    expect(advanceNativeProgress(first, next)).toEqual(next);
    expect(advanceNativeProgress(first, { ...next, elapsedMs: 9 })).toBeNull();
    expect(
      advanceNativeProgress(first, {
        ...next,
        completed: [
          { stage: "BOOT", elapsedMs: 3 },
          { stage: "VERIFY_TIME", elapsedMs: 10 },
        ],
      }),
    ).toBeNull();
  });
});
