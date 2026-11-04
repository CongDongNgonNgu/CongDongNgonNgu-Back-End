import { executeSmoke, type SmokeJob } from "./smoke";
const baseline = { current: 100000000, limit: 536870912, oom: 0, oomKill: 0 };
const io = () => ({
  sample: jest.fn(async () => ({ ...baseline })),
  health: jest.fn(async () => 10),
  rss: () => 50000000,
});
const job = (name = "jpeg"): SmokeJob => ({
  name,
  run: jest.fn(async () => ({
    workerRssBytes: 100000000,
    normalizedBytes: 100,
    thumbnailBytes: 50,
  })),
  stop: jest.fn(async () => {}),
});
describe("serial finite runtime smoke", () => {
  it("measures actual callbacks and serial jobs, retaining bounded numeric results", async () => {
    const first = job(),
      second = job("video"),
      observations = io();
    const result = await executeSmoke(
      [first, second],
      observations,
      new AbortController().signal,
    );
    expect(result.stages.map((item) => item.name)).toEqual(["jpeg", "video"]);
    expect(result.baselineHealthMs).toHaveLength(3);
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(result.cgroupPeakBytes).toBe(baseline.current);
  });
  it("fails on changed OOM counters before starting any processor", async () => {
    const first = job(),
      observations = io();
    observations.sample
      .mockResolvedValueOnce(baseline)
      .mockResolvedValue({ ...baseline, oomKill: 1 });
    await expect(
      executeSmoke([first], observations, new AbortController().signal),
    ).rejects.toThrow("PHASE30_PROBE_RESOURCE_UNVERIFIED");
    expect(first.run).not.toHaveBeenCalled();
  });
  it("does not retry a failed processor and always shuts down the admitted job", async () => {
    const first = job(),
      second = job("video");
    (first.run as jest.Mock).mockRejectedValue(Error("private-child-output"));
    await expect(
      executeSmoke([first, second], io(), new AbortController().signal),
    ).rejects.toThrow();
    expect(first.run).toHaveBeenCalledTimes(1);
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.run).not.toHaveBeenCalled();
  });
  it("aborts pending work and invokes cleanup without accepting late results", async () => {
    const abort = new AbortController(),
      first = job();
    (first.run as jest.Mock).mockImplementation(async () => {
      abort.abort();
      return new Promise(() => {});
    });
    await expect(executeSmoke([first], io(), abort.signal)).rejects.toThrow(
      "PHASE30_PROBE_ABORTED",
    );
    expect(first.stop).toHaveBeenCalledTimes(1);
  });
  it("rejects near-limit aggregate memory and invalid observation values", async () => {
    for (const current of [402653185]) {
      const observations = io();
      observations.sample.mockResolvedValue({ ...baseline, current });
      await expect(
        executeSmoke([job()], observations, new AbortController().signal),
      ).rejects.toThrow("PHASE30_PROBE_HEADROOM");
    }
  });
});

it("keeps resource observation active after eight health probes", async () => {
  const first = job(),
    observations = io();
  let calls = 0,
    running = false,
    timer: NodeJS.Timeout | undefined;
  (first.run as jest.Mock).mockImplementation(
    () =>
      new Promise((resolve) => {
        running = true;
        timer = setTimeout(() => {
          running = false;
          resolve({
            workerRssBytes: 100000000,
            normalizedBytes: 100,
            thumbnailBytes: 50,
          });
        }, 1600);
      }),
  );
  observations.sample.mockImplementation(async () => ({
    ...baseline,
    current: ++calls >= 12 && running ? 450000000 : baseline.current,
  }));
  try {
    await expect(
      executeSmoke([first], observations, new AbortController().signal),
    ).rejects.toThrow("PHASE30_PROBE_HEADROOM");
  } finally {
    if (timer) clearTimeout(timer);
  }
  expect(first.stop).toHaveBeenCalledTimes(1);
});
it("rechecks stage admission before scheduling native work", async () => {
  const first = job(),
    observations = io();
  observations.sample
    .mockResolvedValueOnce(baseline)
    .mockResolvedValueOnce(baseline)
    .mockResolvedValue({ ...baseline, oomKill: 1 });
  await expect(
    executeSmoke([first], observations, new AbortController().signal),
  ).rejects.toThrow("PHASE30_PROBE_RESOURCE_UNVERIFIED");
  expect(first.run).not.toHaveBeenCalled();
});
it("bounds a never-settling kernel observation by cancellation", async () => {
  const abort = new AbortController(),
    observations = io();
  observations.sample.mockImplementation(async () => {
    abort.abort();
    return new Promise(() => {});
  });
  await expect(
    executeSmoke([job()], observations, abort.signal),
  ).rejects.toThrow("PHASE30_PROBE_ABORTED");
});
it("denies workload when a visible ancestor has less headroom", async () => {
  const observations = io();
  observations.sample.mockResolvedValue({
    ...baseline,
    ancestors: [{ current: 210000000, limit: 268435456, oom: 0, oomKill: 0 }],
  } as typeof baseline);
  await expect(
    executeSmoke([job()], observations, new AbortController().signal),
  ).rejects.toThrow("PHASE30_PROBE_HEADROOM");
});
