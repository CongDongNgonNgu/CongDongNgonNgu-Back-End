import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { REPUTATION_SYSTEMS, type ReputationLedgerEntry, type ReputationSystem } from './reputation.types';

export const REPUTATION_LEDGER_REPOSITORY = 'REPUTATION_LEDGER_REPOSITORY';

export interface AppendReputationLedgerEntryInput {
  userId: string;
  system: ReputationSystem;
  sourceType: string;
  sourceId: string;
  delta: number;
  reason: string;
  ruleVersion: string;
  idempotencyKey: string;
  reversalOfEntryId: string | null;
  createdAt: Date;
}

export interface ReputationLedgerAppendResult {
  entry: ReputationLedgerEntry;
  created: boolean;
}

export interface ReputationLedgerCursor {
  createdAt: Date;
  id: string;
}

export interface ReputationLedgerListQuery {
  userId: string;
  system?: ReputationSystem;
  before?: ReputationLedgerCursor;
  limit: number;
}

export interface ReputationLedgerRepository {
  append(input: AppendReputationLedgerEntryInput): Promise<ReputationLedgerAppendResult>;
  findById(id: string): Promise<ReputationLedgerEntry | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<ReputationLedgerEntry | null>;
  findByReversalOfEntryId(entryId: string): Promise<ReputationLedgerEntry | null>;
  listByUser(query: ReputationLedgerListQuery): Promise<ReputationLedgerEntry[]>;
  getBalance(userId: string, system: ReputationSystem): Promise<number>;
}

export type ReputationRepositoryConflictCode =
  | 'REPUTATION_INPUT_INVALID'
  | 'REPUTATION_IDEMPOTENCY_CONFLICT'
  | 'REPUTATION_REVERSAL_EXISTS'
  | 'REPUTATION_REFERENCE_INVALID';

export class ReputationRepositoryConflictError extends Error {
  readonly name = 'ReputationRepositoryConflictError';

  constructor(
    readonly code: ReputationRepositoryConflictCode,
    message: string,
  ) {
    super(message);
  }
}

export class InMemoryReputationLedgerRepository implements ReputationLedgerRepository {
  private readonly entries = new Map<string, ReputationLedgerEntry>();
  private readonly entriesByIdempotency = new Map<string, string>();
  private readonly entriesByReversal = new Map<string, string>();

  async append(input: AppendReputationLedgerEntryInput): Promise<ReputationLedgerAppendResult> {
    validateInput(input);
    const existingId = this.entriesByIdempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.entries.get(existingId);
      if (!existing) throw referenceInvalid();
      if (!matchesInput(existing, input)) throw idempotencyConflict();
      return { entry: cloneEntry(existing), created: false };
    }
    if (input.reversalOfEntryId) {
      if (!this.entries.has(input.reversalOfEntryId)) throw referenceInvalid();
      if (this.entriesByReversal.has(input.reversalOfEntryId)) {
        throw reversalExists();
      }
    }

    const entry: ReputationLedgerEntry = {
      id: randomUUID(),
      userId: input.userId,
      system: input.system,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      delta: input.delta,
      reason: input.reason.trim(),
      ruleVersion: input.ruleVersion.trim(),
      idempotencyKey: input.idempotencyKey.trim(),
      reversalOfEntryId: input.reversalOfEntryId,
      createdAt: new Date(input.createdAt),
    };
    this.entries.set(entry.id, entry);
    this.entriesByIdempotency.set(entry.idempotencyKey, entry.id);
    if (entry.reversalOfEntryId) this.entriesByReversal.set(entry.reversalOfEntryId, entry.id);
    return { entry: cloneEntry(entry), created: true };
  }

  async findById(id: string): Promise<ReputationLedgerEntry | null> {
    const entry = this.entries.get(id);
    return entry ? cloneEntry(entry) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<ReputationLedgerEntry | null> {
    const id = this.entriesByIdempotency.get(idempotencyKey);
    return id ? this.findById(id) : null;
  }

  async findByReversalOfEntryId(entryId: string): Promise<ReputationLedgerEntry | null> {
    const id = this.entriesByReversal.get(entryId);
    return id ? this.findById(id) : null;
  }

  async listByUser(query: ReputationLedgerListQuery): Promise<ReputationLedgerEntry[]> {
    validateListQuery(query);
    return [...this.entries.values()]
      .filter((entry) => (
        entry.userId === query.userId &&
        (!query.system || entry.system === query.system) &&
        isBeforeCursor(entry, query.before)
      ))
      .sort(compareNewestFirst)
      .slice(0, query.limit)
      .map(cloneEntry);
  }

  async getBalance(userId: string, system: ReputationSystem): Promise<number> {
    if (!isUuid(userId) || !REPUTATION_SYSTEMS.includes(system)) throw invalidInput();
    let balance = 0;
    for (const entry of this.entries.values()) {
      if (entry.userId === userId && entry.system === system) {
        balance += entry.delta;
        if (!Number.isSafeInteger(balance)) throw invalidInput();
      }
    }
    return balance;
  }
}

export class PostgresReputationLedgerRepository implements ReputationLedgerRepository {
  constructor(private readonly pool: Pool) {}

  async append(input: AppendReputationLedgerEntryInput): Promise<ReputationLedgerAppendResult> {
    validateInput(input);
    try {
      const result = await this.pool.query(
        `INSERT INTO reputation_ledger_entries (
           user_id,
           system,
           source_type,
           source_id,
           delta,
           reason,
           rule_version,
           idempotency_key,
           reversal_of_entry_id,
           created_at
         )
         VALUES (
           $1::uuid,
           $2::reputation_system,
           $3::reputation_source_type,
           $4::uuid,
           $5,
           $6,
           $7,
           $8,
           $9::uuid,
           $10::timestamptz
         )
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id, user_id, system, source_type, source_id, delta,
                   reason, rule_version, idempotency_key, reversal_of_entry_id,
                   created_at`,
        [
          input.userId,
          input.system,
          input.sourceType,
          input.sourceId,
          input.delta,
          input.reason.trim(),
          input.ruleVersion.trim(),
          input.idempotencyKey.trim(),
          input.reversalOfEntryId,
          input.createdAt,
        ],
      );
      if (result.rows[0]) {
        return { entry: mapRow(result.rows[0]), created: true };
      }
      const existing = await this.findByIdempotencyKey(input.idempotencyKey);
      if (!existing) throw referenceInvalid();
      if (!matchesInput(existing, input)) throw idempotencyConflict();
      return { entry: existing, created: false };
    } catch (error) {
      throw mapPostgresError(error);
    }
  }

  async findById(id: string): Promise<ReputationLedgerEntry | null> {
    if (!isUuid(id)) throw invalidInput();
    const result = await this.pool.query(
      `SELECT id, user_id, system, source_type, source_id, delta,
              reason, rule_version, idempotency_key, reversal_of_entry_id,
              created_at
         FROM reputation_ledger_entries
        WHERE id = $1::uuid`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<ReputationLedgerEntry | null> {
    if (!isBoundedText(idempotencyKey, 200)) throw invalidInput();
    const result = await this.pool.query(
      `SELECT id, user_id, system, source_type, source_id, delta,
              reason, rule_version, idempotency_key, reversal_of_entry_id,
              created_at
         FROM reputation_ledger_entries
        WHERE idempotency_key = $1`,
      [idempotencyKey.trim()],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findByReversalOfEntryId(entryId: string): Promise<ReputationLedgerEntry | null> {
    if (!isUuid(entryId)) throw invalidInput();
    const result = await this.pool.query(
      `SELECT id, user_id, system, source_type, source_id, delta,
              reason, rule_version, idempotency_key, reversal_of_entry_id,
              created_at
         FROM reputation_ledger_entries
        WHERE reversal_of_entry_id = $1::uuid`,
      [entryId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async listByUser(query: ReputationLedgerListQuery): Promise<ReputationLedgerEntry[]> {
    validateListQuery(query);
    const result = await this.pool.query(
      `SELECT id, user_id, system, source_type, source_id, delta,
              reason, rule_version, idempotency_key, reversal_of_entry_id,
              created_at
         FROM reputation_ledger_entries
        WHERE user_id = $1::uuid
          AND ($2::reputation_system IS NULL OR system = $2::reputation_system)
          AND (
            $4::timestamptz IS NULL OR
            created_at < $4::timestamptz OR
            (created_at = $4::timestamptz AND id < $5::uuid)
          )
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [
        query.userId,
        query.system ?? null,
        query.limit,
        query.before?.createdAt ?? null,
        query.before?.id ?? null,
      ],
    );
    return result.rows.map(mapRow);
  }

  async getBalance(userId: string, system: ReputationSystem): Promise<number> {
    if (!isUuid(userId) || !REPUTATION_SYSTEMS.includes(system)) throw invalidInput();
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(delta), 0)::bigint AS balance
         FROM reputation_ledger_entries
        WHERE user_id = $1::uuid
          AND system = $2::reputation_system`,
      [userId, system],
    );
    const balance = Number(result.rows[0]?.balance ?? 0);
    if (!Number.isSafeInteger(balance)) throw invalidInput();
    return balance;
  }
}

function validateInput(input: AppendReputationLedgerEntryInput): void {
  if (
    !isUuid(input.userId) ||
    !REPUTATION_SYSTEMS.includes(input.system) ||
    !isUuid(input.sourceId) ||
    !isBoundedText(input.sourceType, 80) ||
    !Number.isSafeInteger(input.delta) ||
    input.delta === 0 ||
    Math.abs(input.delta) > 100_000 ||
    !isBoundedText(input.reason, 240) ||
    !isBoundedText(input.ruleVersion, 64) ||
    !isBoundedText(input.idempotencyKey, 200) ||
    (input.reversalOfEntryId !== null && !isUuid(input.reversalOfEntryId)) ||
    !(input.createdAt instanceof Date) ||
    !Number.isFinite(input.createdAt.getTime())
  ) {
    throw invalidInput();
  }
}

function validateListQuery(query: ReputationLedgerListQuery): void {
  if (
    !isUuid(query.userId) ||
    (query.system !== undefined && !REPUTATION_SYSTEMS.includes(query.system)) ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 100 ||
    (query.before !== undefined && (
      !isUuid(query.before.id) ||
      !(query.before.createdAt instanceof Date) ||
      !Number.isFinite(query.before.createdAt.getTime())
    ))
  ) {
    throw invalidInput();
  }
}

function matchesInput(entry: ReputationLedgerEntry, input: AppendReputationLedgerEntryInput): boolean {
  return (
    entry.userId === input.userId &&
    entry.system === input.system &&
    entry.sourceType === input.sourceType &&
    entry.sourceId === input.sourceId &&
    entry.delta === input.delta &&
    entry.reason === input.reason.trim() &&
    entry.ruleVersion === input.ruleVersion.trim() &&
    entry.reversalOfEntryId === input.reversalOfEntryId
  );
}

function mapRow(row: Record<string, unknown>): ReputationLedgerEntry {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    system: String(row.system) as ReputationSystem,
    sourceType: String(row.source_type),
    sourceId: String(row.source_id),
    delta: Number(row.delta),
    reason: String(row.reason),
    ruleVersion: String(row.rule_version),
    idempotencyKey: String(row.idempotency_key),
    reversalOfEntryId: row.reversal_of_entry_id ? String(row.reversal_of_entry_id) : null,
    createdAt: new Date(String(row.created_at)),
  };
}

function cloneEntry(entry: ReputationLedgerEntry): ReputationLedgerEntry {
  return { ...entry, createdAt: new Date(entry.createdAt) };
}

function isBeforeCursor(entry: ReputationLedgerEntry, cursor: ReputationLedgerCursor | undefined): boolean {
  if (!cursor) return true;
  return entry.createdAt.getTime() < cursor.createdAt.getTime()
    || (entry.createdAt.getTime() === cursor.createdAt.getTime() && entry.id < cursor.id);
}

function compareNewestFirst(left: ReputationLedgerEntry, right: ReputationLedgerEntry): number {
  const byTime = right.createdAt.getTime() - left.createdAt.getTime();
  return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
}

function isBoundedText(value: string, maxLength: number): boolean {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function invalidInput(): ReputationRepositoryConflictError {
  return new ReputationRepositoryConflictError(
    'REPUTATION_INPUT_INVALID',
    'Reputation ledger input is invalid',
  );
}

function idempotencyConflict(): ReputationRepositoryConflictError {
  return new ReputationRepositoryConflictError(
    'REPUTATION_IDEMPOTENCY_CONFLICT',
    'Reputation idempotency key was reused with different facts',
  );
}

function reversalExists(): ReputationRepositoryConflictError {
  return new ReputationRepositoryConflictError(
    'REPUTATION_REVERSAL_EXISTS',
    'Reputation ledger entry already has a reversal',
  );
}

function referenceInvalid(): ReputationRepositoryConflictError {
  return new ReputationRepositoryConflictError(
    'REPUTATION_REFERENCE_INVALID',
    'Reputation ledger reference is invalid',
  );
}

function mapPostgresError(error: unknown): Error {
  if (error instanceof ReputationRepositoryConflictError) return error;
  if (isPostgresError(error)) {
    if (error.code === '23505' && error.constraint === 'reputation_ledger_reversal_unique_idx') {
      return reversalExists();
    }
    if (error.code === '23505' && error.constraint === 'reputation_ledger_idempotency_unique') {
      return idempotencyConflict();
    }
    if (error.code === '23503') return referenceInvalid();
    if (error.code === '23514' || error.code === '22P02') return invalidInput();
  }
  return error instanceof Error ? error : new Error('Reputation ledger persistence failed');
}

function isPostgresError(error: unknown): error is { code: string; constraint?: string } {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string';
}
