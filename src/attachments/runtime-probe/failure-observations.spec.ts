import { collectFailureObservations } from "./failure-observations";
const sample = { current: 100, limit: 512 * 1048576, oom: 1, oomKill: 0 };
describe("bounded post-shutdown observations", () => {
  it("retains actual counters and verified exact scratch absence separately", async () => {
    const cleanup = jest.fn(async () => true);
    expect(
      await collectFailureObservations(
        { resources: async () => sample, rss: () => 200, cleanup },
        true,
      ),
    ).toEqual({
      resourceStatus: "OBSERVED",
      resource: sample,
      appRssBytes: 200,
      scratchStatus: "VERIFIED_ABSENT",
      scratchResidual: 0,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("never removes scratch for an unquiesced or uncertain producer", async () => {
    const cleanup = jest.fn(async () => true);
    const value = await collectFailureObservations(
      { resources: async () => sample, rss: () => 200, cleanup },
      false,
    );
    expect(value.scratchStatus).toBe("NOT_ATTEMPTED_PRODUCER_UNCERTAINTY");
    expect(value.scratchResidual).toBe("UNVERIFIED");
    expect(cleanup).not.toHaveBeenCalled();
  });
  it("bounds stalled observations without inventing zero OOM or cleanup success", async () => {
    const pending = () => new Promise<never>(() => {});
    const value = await collectFailureObservations(
      { resources: pending, rss: () => 200, cleanup: pending },
      true,
      10,
    );
    expect(value.resourceStatus).toBe("UNVERIFIED");
    expect(value.resource).toBeNull();
    expect(value.scratchResidual).toBe("UNVERIFIED");
  });
  it("scrubs invalid fields and observation errors instead of logging private data", async () => {
    const value = await collectFailureObservations(
      {
        resources: async () => {
          throw Error("PRIVATE_ENDPOINT");
        },
        rss: () => 200,
        cleanup: async () => false,
      },
      true,
    );
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE/);
    expect(value.resource).toBeNull();
    const bad = await collectFailureObservations(
      {
        resources: async () => ({ ...sample, oom: NaN }),
        rss: () => 200,
        cleanup: async () => true,
      },
      true,
    );
    expect(bad.resourceStatus).toBe("UNVERIFIED");
  });
});

it("accepts only independently observed exact ENOENT as scratch absence", async () => {
  const { verifyExactScratchAbsent } = await import("./failure-observations");
  expect(
    await verifyExactScratchAbsent(async () => {
      throw Object.assign(Error("private"), { code: "ENOENT" });
    }),
  ).toBe(true);
  expect(
    await verifyExactScratchAbsent(async () => {
      throw Object.assign(Error("private"), { code: "EACCES" });
    }),
  ).toBe(false);
  expect(await verifyExactScratchAbsent(async () => ({}))).toBe(false);
  expect(await verifyExactScratchAbsent(() => new Promise(() => {}), 10)).toBe(
    false,
  );
});

it("projects only closed native failure telemetry and rejects private injected fields", async () => {
  const { safeNativeFailureObservation } =
    await import("./failure-observations");
  const observation = {
    progress: {
      stage: "SOURCE_DECODE",
      elapsedMs: 20,
      completed: [{ stage: "BOOT", elapsedMs: 1 }],
    },
    lastProgressAgeMs: 10,
    peakRssBytes: 100,
    nativeRssObserved: true,
  };
  expect(safeNativeFailureObservation(observation)).toEqual(observation);
  for (const bad of [
    { ...observation, path: "PRIVATE_URL" },
    {
      ...observation,
      progress: { ...observation.progress, path: "PRIVATE_URL" },
    },
    { ...observation, peakRssBytes: NaN },
    { ...observation, lastProgressAgeMs: -1 },
  ])
    expect(safeNativeFailureObservation(bad)).toBeNull();
});
