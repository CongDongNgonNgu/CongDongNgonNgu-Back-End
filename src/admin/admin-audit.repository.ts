import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export const ADMIN_AUDIT_REPOSITORY = 'ADMIN_AUDIT_REPOSITORY';

export interface AdminAuditEntry {
  id: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  correlationId: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AppendAdminAuditInput {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  correlationId: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AdminAuditListQuery {
  actorUserId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  limit: number;
  offset: number;
}

export interface AdminAuditListResult {
  items: AdminAuditEntry[];
  total: number;
}

export interface AdminAuditRepository {
  append(input: AppendAdminAuditInput): Promise<AdminAuditEntry>;
  list(query: AdminAuditListQuery): Promise<AdminAuditListResult>;
}

const SENSITIVE_KEY = /password|token|secret|signature|api[_.-]?key|credential|authorization|cookie|raw[_.-]?payload|private[_.-]?key/iu;
const MAX_STRING_LENGTH = 2_000;
const MAX_OBJECT_KEYS = 80;
const MAX_ARRAY_ITEMS = 80;
const MAX_DEPTH = 5;

export function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeAuditValue(item, depth + 1));
  }
  if (typeof value !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (SENSITIVE_KEY.test(key)) continue;
    const sanitized = sanitizeAuditValue(child, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

export class InMemoryAdminAuditRepository implements AdminAuditRepository {
  private readonly entries = new Map<string, AdminAuditEntry>();

  async append(input: AppendAdminAuditInput): Promise<AdminAuditEntry> {
    const entry: AdminAuditEntry = {
      id: randomUUID(),
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      correlationId: input.correlationId,
      beforeState: sanitizeRecord(input.beforeState),
      afterState: sanitizeRecord(input.afterState),
      metadata: sanitizeRecord(input.metadata),
      createdAt: new Date(input.createdAt),
    };
    this.entries.set(entry.id, entry);
    return cloneAuditEntry(entry);
  }

  async list(query: AdminAuditListQuery): Promise<AdminAuditListResult> {
    const filtered = [...this.entries.values()]
      .filter((entry) => (
        (!query.actorUserId || entry.actorUserId === query.actorUserId) &&
        (!query.action || entry.action === query.action) &&
        (!query.targetType || entry.targetType === query.targetType) &&
        (!query.targetId || entry.targetId === query.targetId)
      ))
      .sort(compareAuditEntries);
    return {
      total: filtered.length,
      items: filtered.slice(query.offset, query.offset + query.limit).map(cloneAuditEntry),
    };
  }
}

export class PostgresAdminAuditRepository implements AdminAuditRepository {
  constructor(private readonly pool: Pool) {}

  async append(input: AppendAdminAuditInput): Promise<AdminAuditEntry> {
    const result = await this.pool.query(
      `INSERT INTO admin_audit_log (
         actor_user_id, action, target_type, target_id, reason, correlation_id,
         before_state, after_state, metadata, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
       RETURNING *`,
      [
        input.actorUserId,
        input.action,
        input.targetType,
        input.targetId,
        input.reason,
        input.correlationId,
        JSON.stringify(sanitizeRecord(input.beforeState)),
        JSON.stringify(sanitizeRecord(input.afterState)),
        JSON.stringify(sanitizeRecord(input.metadata)),
        input.createdAt,
      ],
    );
    return mapAuditEntry(result.rows[0]);
  }

  async list(query: AdminAuditListQuery): Promise<AdminAuditListResult> {
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown): string => {
      values.push(value);
      return '$' + values.length;
    };
    if (query.actorUserId) where.push('actor_user_id = ' + add(query.actorUserId));
    if (query.action) where.push('action = ' + add(query.action));
    if (query.targetType) where.push('target_type = ' + add(query.targetType));
    if (query.targetId) where.push('target_id = ' + add(query.targetId));
    const filter = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const count = await this.pool.query('SELECT COUNT(*)::int AS count FROM admin_audit_log' + filter, values);
    const limitParameter = add(query.limit);
    const offsetParameter = add(query.offset);
    const result = await this.pool.query(
      `SELECT * FROM admin_audit_log${filter}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
      values,
    );
    return {
      total: Number(count.rows[0]?.count ?? 0),
      items: result.rows.map(mapAuditEntry),
    };
  }
}

function sanitizeRecord(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (value === null) return null;
  const sanitized = sanitizeAuditValue(value);
  return (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized))
    ? sanitized as Record<string, unknown>
    : {};
}

function compareAuditEntries(left: AdminAuditEntry, right: AdminAuditEntry): number {
  const timeDifference = right.createdAt.getTime() - left.createdAt.getTime();
  return timeDifference !== 0 ? timeDifference : right.id.localeCompare(left.id);
}

function cloneAuditEntry(entry: AdminAuditEntry): AdminAuditEntry {
  return {
    ...entry,
    beforeState: cloneRecord(entry.beforeState),
    afterState: cloneRecord(entry.afterState),
    metadata: cloneRecord(entry.metadata),
    createdAt: new Date(entry.createdAt),
  };
}

function cloneRecord(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (value === null) return null;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function mapAuditEntry(row: Record<string, unknown>): AdminAuditEntry {
  return {
    id: String(row.id),
    actorUserId: String(row.actor_user_id),
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: String(row.target_id),
    reason: String(row.reason),
    correlationId: String(row.correlation_id),
    beforeState: jsonRecord(row.before_state),
    afterState: jsonRecord(row.after_state),
    metadata: jsonRecord(row.metadata),
    createdAt: new Date(String(row.created_at)),
  };
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
