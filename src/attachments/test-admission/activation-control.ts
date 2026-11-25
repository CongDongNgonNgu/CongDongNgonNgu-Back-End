import type { Pool, PoolClient } from "pg";
export interface ControlTuple {
  readonly runId: string;
  readonly activationId: string;
  readonly sourceSha: string;
  readonly manifestSha256: string;
  readonly service: string;
  readonly branch: string;
  readonly deploymentId: string;
  readonly bootId: string;
  readonly notBefore: string;
  readonly expiresAt: string;
}
export interface OperatorReceipt {
  readonly service: string;
  readonly branch: string;
  readonly sha: string;
  readonly manifestSha256: string;
  readonly deploymentId: string;
  readonly bootId: string;
  readonly observedAt: string;
  readonly liveObserved: true;
  readonly originalDisabledCommandObserved: true;
  readonly allFourFlagsFalseObserved: true;
}
export interface ControlSnapshot {
  readonly tuple: ControlTuple;
  readonly runState: "PREPARED" | "ACTIVE" | "CLOSED" | "EXPIRED";
  readonly state: "ARMED" | "RECEIPT_STORED" | "CONSUMED";
  readonly consumedAt: string | null;
  readonly armedAt: string;
  readonly receipt: OperatorReceipt | null;
  readonly receiptStoredAt: string | null;
}
const tupleKeys = [
  "runId",
  "activationId",
  "sourceSha",
  "manifestSha256",
  "service",
  "branch",
  "deploymentId",
  "bootId",
  "notBefore",
  "expiresAt",
] as const;
const receiptKeys = [
  "service",
  "branch",
  "sha",
  "manifestSha256",
  "deploymentId",
  "bootId",
  "observedAt",
  "liveObserved",
  "originalDisabledCommandObserved",
  "allFourFlagsFalseObserved",
] as const;
const fail = (): never => {
  throw Error("TEST_ACTIVATION_CONTROL");
};
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((k) => typeof k !== "string" || !keys.includes(k))
  )
    return fail();
  const out = Object.create(null) as Record<string, unknown>;
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (!d || !d.enumerable || !("value" in d)) return fail();
    out[k] = d.value;
  }
  return out;
}
function canonical(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return fail();
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value)
    return fail();
  return value;
}
/** Closed declaration snapshot only; does not attest process/deployment identity. */
export function parseControlTuple(value: unknown): ControlTuple {
  const r = record(value, tupleKeys);
  for (const k of ["runId", "activationId", "bootId"])
    if (
      typeof r[k] !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        r[k] as string,
      )
    )
      return fail();
  if (
    typeof r.sourceSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(r.sourceSha) ||
    typeof r.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.manifestSha256) ||
    r.service !== "srv-dahnerh594qs73fp3420" ||
    r.branch !== "dev" ||
    typeof r.deploymentId !== "string" ||
    !/^dep-[a-z0-9-]{1,80}$/.test(r.deploymentId)
  )
    return fail();
  const start = Date.parse(canonical(r.notBefore)),
    end = Date.parse(canonical(r.expiresAt));
  if (end <= start || end - start > 600000) return fail();
  return Object.freeze({ ...r }) as unknown as ControlTuple;
}
function receipt(value: unknown, t: ControlTuple): OperatorReceipt {
  const r = record(value, receiptKeys);
  canonical(r.observedAt);
  if (
    r.service !== t.service ||
    r.branch !== t.branch ||
    r.sha !== t.sourceSha ||
    r.manifestSha256 !== t.manifestSha256 ||
    r.deploymentId !== t.deploymentId ||
    r.bootId !== t.bootId ||
    r.liveObserved !== true ||
    r.originalDisabledCommandObserved !== true ||
    r.allFourFlagsFalseObserved !== true
  )
    return fail();
  return Object.freeze({ ...r }) as unknown as OperatorReceipt;
}
const values = (t: ControlTuple) => tupleKeys.map((k) => t[k]);
const exact =
  "c.run_id=$1 AND c.activation_id=$2 AND c.source_sha=$3 AND c.manifest_sha256=$4 AND c.service_id=$5 AND c.branch=$6 AND c.deployment_id=$7 AND c.boot_id=$8 AND c.not_before=$9::timestamptz AND c.expires_at=$10::timestamptz";
const runLock =
  "SELECT run_id FROM phase30_test_execution.runs WHERE run_id=$1 AND activation_id=$2 AND source_sha=$3 AND manifest_sha256=$4 AND service_id=$5 AND not_before=$9::timestamptz AND expires_at=$10::timestamptz AND $6::text='dev' AND $7::text ~ '^dep-[a-z0-9-]{1,80}$' AND $8::uuid IS NOT NULL AND activation_control_required AND preparation_sealed AND state='PREPARED' FOR UPDATE";
/** Inert operator storage only. Trusted injected pool; no connection/DDL on import.
 * Receipt booleans record procedure, not cryptographic upstream attestation.
 * No consume/activate/poll/worker API, runtime grant, provider or fixture operation. */
export class ActivationControlRepository {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(
    work: (c: PoolClient) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    let c: PoolClient | undefined;
    try {
      c = await this.pool.connect();
      await c.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
      await c.query("SET LOCAL statement_timeout='3000ms'");
      await c.query("SET LOCAL lock_timeout='2000ms'");
      const result = await work(c);
      await c.query("COMMIT");
      return result;
    } catch {
      if (c)
        try {
          await c.query("ROLLBACK");
        } catch {
          /* Outcome may be uncertain. Never retry. */
        }
      return fail();
    } finally {
      c?.release();
    }
  }
  async arm(input: ControlTuple): Promise<void> {
    try {
      const t = parseControlTuple(input),
        v = values(t);
      await this.transaction(async (c) => {
        if ((await c.query(runLock, v)).rowCount !== 1) return fail();
        const changed = await c.query(
          "INSERT INTO phase30_test_execution.activation_controls(run_id,activation_id,source_sha,manifest_sha256,service_id,branch,deployment_id,boot_id,not_before,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          v,
        );
        if (changed.rowCount !== 1) return fail();
      });
    } catch {
      return fail();
    }
  }
  async storeReceipt(
    input: ControlTuple,
    observation: OperatorReceipt,
  ): Promise<void> {
    try {
      const t = parseControlTuple(input),
        r = receipt(observation, t),
        v = values(t);
      await this.transaction(async (c) => {
        if ((await c.query(runLock, v)).rowCount !== 1) return fail();
        if (
          (
            await c.query(
              "SELECT c.run_id FROM phase30_test_execution.activation_controls c WHERE " +
                exact +
                " AND c.state='ARMED' FOR UPDATE",
              v,
            )
          ).rowCount !== 1
        )
          return fail();
        const changed = await c.query(
          "UPDATE phase30_test_execution.activation_controls c SET state='RECEIPT_STORED',receipt=$11::jsonb WHERE " +
            exact +
            " AND c.state='ARMED'",
          [...v, JSON.stringify(r)],
        );
        if (changed.rowCount !== 1) return fail();
      });
    } catch {
      return fail();
    }
  }
  async inspectExact(input: ControlTuple): Promise<ControlSnapshot | null> {
    try {
      const t = parseControlTuple(input);
      return await this.transaction(async (c) => {
        const row = (
          await c.query(
            "SELECT c.state,c.armed_at,c.receipt,c.receipt_stored_at,c.consumed_at,r.state AS run_state FROM phase30_test_execution.activation_controls c JOIN phase30_test_execution.runs r USING(run_id) WHERE " +
              exact,
            values(t),
          )
        ).rows[0];
        if (!row) return null;
        if (
          !["PREPARED", "ACTIVE", "CLOSED", "EXPIRED"].includes(
            row.run_state,
          ) ||
          !["ARMED", "RECEIPT_STORED", "CONSUMED"].includes(row.state)
        )
          return fail();
        const stamp = (v: unknown) =>
          v instanceof Date ? canonical(v.toISOString()) : canonical(v);
        const observed = row.receipt === null ? null : receipt(row.receipt, t);
        if((row.state==="CONSUMED")!==(row.consumed_at!==null&&row.consumed_at!==undefined))return fail();
        if (
          (row.state === "ARMED") !== (observed === null) ||
          (row.state === "ARMED") !== (row.receipt_stored_at === null)
        )
          return fail();
        return Object.freeze({
          tuple: t,
          runState: row.run_state,
          state: row.state,
          armedAt: stamp(row.armed_at),
          receipt: observed,
          consumedAt: row.consumed_at==null?null:stamp(row.consumed_at),
          receiptStoredAt:
            row.receipt_stored_at === null
              ? null
              : stamp(row.receipt_stored_at),
        }) as ControlSnapshot;
      }, true);
    } catch {
      return fail();
    }
  }
}
