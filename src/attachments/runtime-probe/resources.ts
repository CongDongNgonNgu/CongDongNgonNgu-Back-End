import { open } from "node:fs/promises";
import { posix } from "node:path";
const unavailable = (): never => {
  throw Error("PHASE30_PROBE_RESOURCE_UNVERIFIED");
};
function bounded(value: string): void {
  if (value.length > 65536 || value.includes("\0")) unavailable();
}
function safePath(value: string): boolean {
  return (
    /^\/[A-Za-z0-9_./-]*$/.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}
export function resolveCgroup(membership: string, mountinfo: string): string {
  bounded(membership);
  bounded(mountinfo);
  const groups = membership.trim().split("\n");
  if (groups.length !== 1 || !groups[0].startsWith("0::")) return unavailable();
  const member = groups[0].slice(3);
  const mounts = mountinfo
    .split("\n")
    .filter((line) => line.includes(" - cgroup2 "));
  if (!safePath(member) || mounts.length !== 1) return unavailable();
  const fields = mounts[0].split(" "),
    root = fields[3],
    mount = fields[4];
  if (!safePath(root) || !safePath(mount) || !mount.startsWith("/sys/"))
    return unavailable();
  let relative: string;
  if (member === "/") relative = "";
  else if (root === "/") relative = member.slice(1);
  else if (member === root) relative = "";
  else if (member.startsWith(root + "/"))
    relative = member.slice(root.length + 1);
  else return unavailable();
  const result = posix.join(mount, relative);
  if (result !== mount && !result.startsWith(mount + "/")) return unavailable();
  return result;
}
export interface CgroupSample {
  current: number;
  limit: number;
  oom: number;
  oomKill: number;
  ancestors?: CgroupSample[];
}
function integer(raw: string): number {
  if (!/^\d+\n?$/.test(raw)) return unavailable();
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0) return unavailable();
  return value;
}
export function parseCgroupSample(
  current: string,
  limit: string,
  events: string,
): CgroupSample {
  bounded(events);
  const values = new Map<string, number>();
  for (const line of events.trim().split("\n")) {
    const parts = /^([a-z_]+) (\d+)$/.exec(line);
    if (!parts || values.has(parts[1])) return unavailable();
    values.set(parts[1], integer(parts[2]));
  }
  const oom = values.get("oom"),
    oomKill = values.get("oom_kill"),
    used = integer(current),
    maximum = integer(limit);
  if (oom === undefined || oomKill === undefined || !maximum || used > maximum)
    return unavailable();
  return { current: used, limit: maximum, oom, oomKill };
}
/** Only fixed kernel observation files; bytes are capped before decoding. */
async function readKernel(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) return unavailable();
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
export async function resourceReader(
  read: typeof readKernel = readKernel,
): Promise<() => Promise<CgroupSample>> {
  const [group, mountinfo] = await Promise.all([
    read("/proc/self/cgroup"),
    read("/proc/self/mountinfo"),
  ]);
  const leaf = resolveCgroup(group, mountinfo),
    mount = mountinfo
      .split("\n")
      .find((line) => line.includes(" - cgroup2 "))!
      .split(" ")[4];
  const roots = [leaf];
  let current = leaf;
  while (current !== mount) {
    current = posix.dirname(current);
    if (current !== mount && !current.startsWith(mount + "/"))
      return unavailable();
    roots.push(current);
    if (roots.length > 32) return unavailable();
  }
  return async () => {
    const values = await Promise.all(
      roots.map(async (root, index) => {
        const [current, limit, events] = await Promise.all(
          ["memory.current", "memory.max", "memory.events"].map((name) =>
            read(posix.join(root, name)),
          ),
        );
        // An unlimited visible ancestor adds no finite constraint. The leaf must be finite.
        if (index > 0 && limit.trim() === "max") return null;
        return parseCgroupSample(current, limit, events);
      }),
    );
    const leafSample = values[0];
    if (!leafSample) return unavailable();
    return {
      ...leafSample,
      ancestors: values
        .slice(1)
        .filter((value): value is CgroupSample => value !== null),
    };
  };
}
