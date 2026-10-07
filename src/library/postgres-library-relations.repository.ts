import type { Pool } from 'pg';
import {
  compareRelations,
  type LibraryRelationsRepository,
} from './library-relations.repository';
import type {
  LibraryRelationRecord,
  LibraryRelationType,
} from './library-relations.types';
export class PostgresLibraryRelationsRepository implements LibraryRelationsRepository {
  constructor(private readonly pool: Pool) {}
  async scan(
    anchorId: string,
    after: string | null,
    relation: LibraryRelationType | null,
  ) {
    const identities = await this.pool.query(
      `SELECT DISTINCT target_resource_id FROM library_resource_relations WHERE anchor_resource_id=$1 AND status='ACTIVE' AND ($2::uuid IS NULL OR target_resource_id>$2) AND ($3::text IS NULL OR relation_type=$3) ORDER BY target_resource_id LIMIT 64`,
      [anchorId, after, relation],
    );
    const targets = identities.rows.map((r) => String(r.target_resource_id));
    const assertions = (await this.findForTargets(anchorId, targets)).filter(
      (r) => r.status === 'ACTIVE' && (!relation || r.type === relation),
    );
    const more =
      targets.length === 64
        ? await this.pool.query(
            `SELECT EXISTS(SELECT 1 FROM library_resource_relations WHERE anchor_resource_id=$1 AND status='ACTIVE' AND target_resource_id>$2 AND ($3::text IS NULL OR relation_type=$3)) AS has_more`,
            [anchorId, targets[targets.length - 1], relation],
          )
        : null;
    return { assertions, targets, hasMore: Boolean(more?.rows[0]?.has_more) };
  }
  async findForTargets(anchorId: string, targets: readonly string[]) {
    if (!targets.length) return [];
    const result = await this.pool.query(
      'SELECT * FROM library_resource_relations WHERE anchor_resource_id=$1 AND target_resource_id=ANY($2::uuid[])',
      [anchorId, targets],
    );
    return result.rows.map(map).sort(compareRelations);
  }
  async review(r: Omit<LibraryRelationRecord, 'revision' | 'status'>) {
    const result = await this.pool.query(
      `INSERT INTO library_resource_relations (anchor_resource_id,target_resource_id,relation_type,reviewer_user_id,reviewed_at,evidence_reference,anchor_snapshot,target_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (anchor_resource_id,target_resource_id,relation_type) DO UPDATE SET reviewer_user_id=EXCLUDED.reviewer_user_id,reviewed_at=EXCLUDED.reviewed_at,evidence_reference=EXCLUDED.evidence_reference,anchor_snapshot=EXCLUDED.anchor_snapshot,target_snapshot=EXCLUDED.target_snapshot,status='ACTIVE',revision=library_resource_relations.revision+1 RETURNING *`,
      [
        r.anchorId,
        r.targetId,
        r.type,
        r.reviewerUserId,
        r.reviewedAt,
        r.evidenceReference,
        r.anchorSnapshot,
        r.targetSnapshot,
      ],
    );
    return map(result.rows[0]);
  }
  async revoke(anchorId: string, targetId: string, type: LibraryRelationType) {
    await this.pool.query(
      `UPDATE library_resource_relations SET status='REVOKED',revision=revision+1 WHERE anchor_resource_id=$1 AND target_resource_id=$2 AND relation_type=$3`,
      [anchorId, targetId, type],
    );
  }
}
function map(r: Record<string, unknown>): LibraryRelationRecord {
  return {
    anchorId: String(r.anchor_resource_id),
    targetId: String(r.target_resource_id),
    type: r.relation_type as LibraryRelationType,
    reviewerUserId: String(r.reviewer_user_id),
    reviewedAt: new Date(r.reviewed_at as Date),
    evidenceReference: String(r.evidence_reference),
    anchorSnapshot: String(r.anchor_snapshot),
    targetSnapshot: String(r.target_snapshot),
    revision: Number(r.revision),
    status: r.status as LibraryRelationRecord['status'],
  };
}
