export const NATIVE_PROGRESS_STAGES = [
  "BOOT",
  "VERIFY_TIME",
  "VERIFY_DISTRIBUTION",
  "VERIFY_FFMPEG",
  "VERIFY_FFPROBE",
  "INPUT_VALIDATE",
  "SOURCE_PROBE",
  "SOURCE_DECODE",
  "NORMALIZE",
  "OUTPUT_VALIDATE",
  "OUTPUT_PROBE",
  "OUTPUT_DECODE",
  "THUMBNAIL",
  "THUMBNAIL_VALIDATE",
  "THUMBNAIL_DECODE",
  "RESULT",
] as const;
export type NativeProgressStage = (typeof NATIVE_PROGRESS_STAGES)[number];
export interface NativeProgress {
  stage: NativeProgressStage;
  elapsedMs: number;
  completed: ReadonlyArray<{ stage: NativeProgressStage; elapsedMs: number }>;
}
const elapsed = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 15000;
const stage = (value: unknown): value is NativeProgressStage =>
  NATIVE_PROGRESS_STAGES.includes(value as never);
const exact = (
  value: unknown,
  keys: string[],
): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((k) => keys.includes(k));
/** Bounded closed vocabulary. No worker paths, arguments, stderr, PIDs or environment. */
export function parseNativeProgress(input: unknown): NativeProgress | null {
  if (
    !exact(input, ["stage", "elapsedMs", "completed"]) ||
    !stage(input.stage) ||
    !elapsed(input.elapsedMs) ||
    !Array.isArray(input.completed) ||
    input.completed.length > NATIVE_PROGRESS_STAGES.length
  )
    return null;
  const completed: Array<{ stage: NativeProgressStage; elapsedMs: number }> =
      [],
    seen = new Set<string>();
  let total = 0;
  for (const item of input.completed) {
    if (
      !exact(item, ["stage", "elapsedMs"]) ||
      !stage(item.stage) ||
      !elapsed(item.elapsedMs) ||
      seen.has(item.stage) ||
      item.stage === input.stage
    )
      return null;
    seen.add(item.stage);
    total += item.elapsedMs;
    completed.push({ stage: item.stage, elapsedMs: item.elapsedMs });
  }
  if (total > input.elapsedMs + 0.000001) return null;
  return { stage: input.stage, elapsedMs: input.elapsedMs, completed };
}
export function advanceNativeProgress(
  previous: unknown,
  input: unknown,
): NativeProgress | null {
  const next = parseNativeProgress(input);
  if (!next) return null;
  if (previous === undefined) return next;
  const before = parseNativeProgress(previous);
  if (!before || next.elapsedMs < before.elapsedMs) return null;
  if (
    before.completed.some(
      (s, i) =>
        next.completed[i]?.stage !== s.stage ||
        next.completed[i]?.elapsedMs !== s.elapsedMs,
    )
  )
    return null;
  if (next.stage === before.stage)
    return next.completed.length === before.completed.length ? next : null;
  if (next.completed.length !== before.completed.length + 1) return null;
  const completed = next.completed.at(-1)!,
    previousCompleted = before.completed.reduce(
      (sum, s) => sum + s.elapsedMs,
      0,
    );
  return completed.stage === before.stage &&
    completed.elapsedMs + 0.000001 >= before.elapsedMs - previousCompleted
    ? next
    : null;
}
export class NativeProgressClock {
  private readonly start: number;
  private last: number;
  private entered: number;
  private current: NativeProgressStage = "BOOT";
  private readonly completed: Array<{
    stage: NativeProgressStage;
    elapsedMs: number;
  }> = [];
  constructor(private readonly now: () => number = () => performance.now()) {
    this.start = this.last = this.entered = now();
    if (!Number.isFinite(this.start) || this.start < 0)
      throw Error("NATIVE_PROGRESS_INVALID");
  }
  private read(): number {
    const now = this.now();
    if (!Number.isFinite(now) || now < this.last)
      throw Error("NATIVE_PROGRESS_INVALID");
    this.last = now;
    return now;
  }
  enter(next: NativeProgressStage): void {
    if (!stage(next) || this.completed.some((s) => s.stage === next))
      throw Error("NATIVE_PROGRESS_INVALID");
    if (next === this.current) return;
    const now = this.read();
    this.completed.push({ stage: this.current, elapsedMs: now - this.entered });
    this.entered = now;
    this.current = next;
  }
  snapshot(): NativeProgress | null {
    const now = this.read();
    // Omit expired telemetry; the unchanged supervisor owns deadline classification.
    if (now - this.start > 15000) return null;
    return {
      stage: this.current,
      elapsedMs: now - this.start,
      completed: this.completed.map((s) => ({ ...s })),
    };
  }
}
