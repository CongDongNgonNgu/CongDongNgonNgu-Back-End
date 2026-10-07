import {
  LIBRARY_RELATION_TYPES,
  type LibraryRelationRecord,
  type LibraryRelationType,
} from './library-relations.types';
export const LIBRARY_RELATIONS_REPOSITORY = 'LIBRARY_RELATIONS_REPOSITORY';
export interface LibraryRelationsRepository {
  scan(
    anchorId: string,
    after: string | null,
    relation: LibraryRelationType | null,
  ): Promise<{
    assertions: LibraryRelationRecord[];
    targets: string[];
    hasMore: boolean;
  }>;
  findForTargets(
    anchorId: string,
    targets: readonly string[],
  ): Promise<LibraryRelationRecord[]>;
  review(
    input: Omit<LibraryRelationRecord, 'revision' | 'status'>,
  ): Promise<LibraryRelationRecord>;
  revoke(
    anchorId: string,
    targetId: string,
    type: LibraryRelationType,
  ): Promise<void>;
}
export function compareRelations(
  a: LibraryRelationRecord,
  b: LibraryRelationRecord,
): number {
  return a.targetId < b.targetId
    ? -1
    : a.targetId > b.targetId
      ? 1
      : LIBRARY_RELATION_TYPES.indexOf(a.type) -
        LIBRARY_RELATION_TYPES.indexOf(b.type);
}
function key(r: Pick<LibraryRelationRecord, 'anchorId' | 'targetId' | 'type'>) {
  return JSON.stringify([r.anchorId, r.targetId, r.type]);
}
function clone(r: LibraryRelationRecord) {
  return { ...r, reviewedAt: new Date(r.reviewedAt) };
}
export class InMemoryLibraryRelationsRepository implements LibraryRelationsRepository {
  private readonly records = new Map<string, LibraryRelationRecord>();
  async scan(
    anchorId: string,
    after: string | null,
    relation: LibraryRelationType | null,
  ) {
    const all = [...this.records.values()]
      .filter(
        (r) =>
          r.anchorId === anchorId &&
          r.status === 'ACTIVE' &&
          (!after || r.targetId > after) &&
          (!relation || r.type === relation),
      )
      .sort(compareRelations);
    const targets = [...new Set(all.map((r) => r.targetId))];
    const selected = new Set(targets.slice(0, 64));
    return {
      assertions: all.filter((r) => selected.has(r.targetId)).map(clone),
      targets: targets.slice(0, 64),
      hasMore: targets.length > 64,
    };
  }
  async findForTargets(anchorId: string, targets: readonly string[]) {
    const selected = new Set(targets);
    return [...this.records.values()]
      .filter((r) => r.anchorId === anchorId && selected.has(r.targetId))
      .sort(compareRelations)
      .map(clone);
  }
  async review(input: Omit<LibraryRelationRecord, 'revision' | 'status'>) {
    const old = this.records.get(key(input));
    const record: LibraryRelationRecord = {
      ...input,
      revision: (old?.revision ?? 0) + 1,
      status: 'ACTIVE',
    };
    this.records.set(key(input), clone(record));
    return clone(record);
  }
  async revoke(anchorId: string, targetId: string, type: LibraryRelationType) {
    const record = this.records.get(key({ anchorId, targetId, type }));
    if (record) {
      record.status = 'REVOKED';
      record.revision++;
    }
  }
}
