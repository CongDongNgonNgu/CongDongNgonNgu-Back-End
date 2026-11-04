import { resolveCgroup, parseCgroupSample } from "./resources";
const mount = "29 23 0:26 / /sys/fs/cgroup ro - cgroup2 cgroup rw";
describe("bounded actual Linux resource observations", () => {
  it("resolves namespaced and nested v2 groups without guessing a path", () => {
    expect(resolveCgroup("0::/\n", mount)).toBe("/sys/fs/cgroup");
    expect(resolveCgroup("0::/render/app\n", mount)).toBe(
      "/sys/fs/cgroup/render/app",
    );
    expect(
      resolveCgroup(
        "0::/render/app\n",
        mount.replace(" / /sys/", " /render /sys/"),
      ),
    ).toBe("/sys/fs/cgroup/app");
  });
  it.each(["", "1:memory:/app", "0::/../private", "0::/app\n0::/foreign"])(
    "rejects unsupported or ambiguous membership %p",
    (value) => {
      expect(() => resolveCgroup(value, mount)).toThrow(
        "PHASE30_PROBE_RESOURCE_UNVERIFIED",
      );
    },
  );
  it("requires a mounted v2 controller and bounded input", () => {
    expect(() => resolveCgroup("0::/app", "")).toThrow();
    expect(() => resolveCgroup("0::/app", mount + "\n" + mount)).toThrow();
    expect(() => resolveCgroup("x".repeat(65537), mount)).toThrow();
  });
  it("retains actual numeric cgroup counters and rejects incomplete observations", () => {
    const events =
      "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n";
    expect(parseCgroupSample("100000\n", "536870912\n", events)).toEqual({
      current: 100000,
      limit: 536870912,
      oom: 0,
      oomKill: 0,
    });
    for (const bad of [
      "",
      "oom 0\n",
      "oom 0\noom_kill -1",
      "oom 0\noom 1\noom_kill 0",
    ])
      expect(() => parseCgroupSample("100000", "536870912", bad)).toThrow();
    for (const bad of ["max", "-1", "1.5", "9007199254740993"])
      expect(() => parseCgroupSample("100000", bad, events)).toThrow();
    expect(() => parseCgroupSample("536870913", "536870912", events)).toThrow();
  });
});

it("reads every visible finite ancestor while retaining the leaf observation", async () => {
  const { resourceReader } = await import("./resources");
  const events = "oom 0\noom_kill 0\n";
  const read = async (file: string) => {
    if (file === "/proc/self/cgroup") return "0::/render/app\n";
    if (file === "/proc/self/mountinfo") return mount;
    if (file.endsWith("/memory.events")) return events;
    if (file.endsWith("/memory.current"))
      return file.includes("/render/app/") ? "100000000" : "210000000";
    if (file === "/sys/fs/cgroup/memory.max") return "max";
    if (file.endsWith("/memory.max"))
      return file.includes("/render/app/") ? "536870912" : "268435456";
    throw Error("Unexpected observation path");
  };
  const sample = await (await resourceReader(read))();
  expect(sample.limit).toBe(536870912);
  expect(sample.ancestors).toEqual([
    { current: 210000000, limit: 268435456, oom: 0, oomKill: 0 },
  ]);
});
