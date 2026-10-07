import type { Pool, PoolClient } from "pg";
import type {
  GroupResponse,
  GroupRow,
  MembershipRow,
  GroupRole,
} from "./study-group.types";
import { StudyGroupFailure, unavailable, uuid } from "./study-group.validation";
export type RateAction =
  | "CREATE"
  | "ACCEPT"
  | "INVITE"
  | "TEXT"
  | "REPORT"
  | "MEMBERSHIP"
  | "MODERATION";
const rates: Record<RateAction, number> = {
  CREATE: 2,
  ACCEPT: 10,
  INVITE: 10,
  TEXT: 20,
  REPORT: 10,
  MEMBERSHIP: 20,
  MODERATION: 20,
};
export async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
export async function lockAccounts(
  client: PoolClient,
  userIds: string[],
  write: boolean,
): Promise<void> {
  const ids = [...new Set(userIds)].sort();
  ids.forEach(uuid);
  const result = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE' ORDER BY id FOR " +
      (write ? "UPDATE" : "SHARE"),
    [ids],
  );
  if (result.rows.length !== ids.length) unavailable();
}
// Independent commit makes failed authenticated attempts durable without holding rate locks during group work.
export async function consumeRate(
  pool: Pool,
  userId: string,
  action: RateAction,
): Promise<void> {
  await transaction(pool, async (client) => {
    await lockAccounts(client, [userId], false);
    const result = await client.query(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS now)
       INSERT INTO study_group_rate_limits(user_id,action,hits,reset_at)
       SELECT $1,$2,1,instant.now + interval '60 seconds' FROM instant WHERE true
       ON CONFLICT (user_id,action) DO UPDATE SET
         hits = CASE WHEN study_group_rate_limits.reset_at <= (SELECT now FROM instant) THEN 1 ELSE study_group_rate_limits.hits + 1 END,
         reset_at = CASE WHEN study_group_rate_limits.reset_at <= (SELECT now FROM instant) THEN (SELECT now FROM instant) + interval '60 seconds' ELSE study_group_rate_limits.reset_at END
       WHERE study_group_rate_limits.reset_at <= (SELECT now FROM instant) OR study_group_rate_limits.hits < $3
       RETURNING hits`,
      [userId, action, rates[action]],
    );
    if (!result.rowCount)
      throw new StudyGroupFailure(
        "GROUP_RATE_LIMITED",
        429,
        "Too many study group requests",
      );
  });
}
export async function lockGroup(
  client: PoolClient,
  groupId: string,
  write: boolean,
): Promise<GroupRow> {
  uuid(groupId);
  const result = await client.query<GroupRow>(
    "SELECT * FROM study_groups WHERE id=$1 FOR " +
      (write ? "UPDATE" : "SHARE"),
    [groupId],
  );
  const group = result.rows[0];
  if (!group || group.status !== "ACTIVE") unavailable();
  return group;
}
export async function membership(
  client: PoolClient,
  groupId: string,
  userId: string,
): Promise<MembershipRow | undefined> {
  const result = await client.query<MembershipRow>(
    "SELECT m.*,u.display_name FROM study_group_memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1 AND m.user_id=$2",
    [groupId, userId],
  );
  return result.rows[0];
}
export async function authorize(
  client: PoolClient,
  groupId: string,
  actorId: string,
  roles?: GroupRole[],
): Promise<MembershipRow> {
  const member = await membership(client, groupId, actorId);
  if (
    !member ||
    member.status !== "ACTIVE" ||
    (roles && !roles.includes(member.role))
  )
    unavailable();
  return member;
}
export function groupResponse(group: GroupRow, role: GroupRole): GroupResponse {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    status: group.status,
    role,
    createdAt: group.created_at.toISOString(),
    updatedAt: group.updated_at.toISOString(),
  };
}
