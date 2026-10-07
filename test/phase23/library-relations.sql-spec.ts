import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { PostgresLibraryRepository } from '../../src/library/postgres-library.repository';
import { PostgresLibraryRelationsRepository } from '../../src/library/postgres-library-relations.repository';
import { PostgresIdentityRepository } from '../../src/identity/postgres-identity.repository';
import { InMemoryProfileRepository } from '../../src/profile/profile.repository';
import { LibraryService } from '../../src/library/library.service';
import { LibraryRelationsService } from '../../src/library/library-relations.service';

describe('Phase23 actual PostgreSQL18 relation proof', () => {
  const schema = 'phase23_test_' + randomUUID().replace(/-/g, '');
  let admin: Pool,
    pool: Pool,
    identity: PostgresIdentityRepository,
    resources: PostgresLibraryRepository,
    relations: PostgresLibraryRelationsRepository,
    service: LibraryRelationsService;
  const migrations = path.resolve(__dirname, '../../database/migrations');
  beforeAll(async () => {
    const raw = process.env.PHASE23_TEST_DATABASE_URL;
    if (!raw)
      throw new Error(
        'PHASE23_TEST_DATABASE_URL required; SQL proof never skips',
      );
    const url = new URL(raw);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      decodeURIComponent(url.pathname.slice(1)) !==
        'congdongngonngu_phase22_ci' ||
      url.searchParams.has('options')
    )
      throw new Error(
        'Phase23 SQL proof requires exact isolated loopback CI database',
      );
    admin = new Pool({ connectionString: raw, max: 2 });
    const guard = (
      await admin.query(
        "SELECT current_database() AS db,current_setting('server_version_num')::int AS version",
      )
    ).rows[0];
    if (guard.db !== 'congdongngonngu_phase22_ci' || guard.version < 180000)
      throw new Error('Phase23 DB guard failed');
    await admin.query('CREATE SCHEMA "' + schema + '"');
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    pool = new Pool({ connectionString: url.toString(), max: 3 });
    expect(
      (await pool.query('SELECT current_schema() AS schema')).rows[0].schema,
    ).toBe(schema);
    const files = (await readdir(migrations))
      .filter((f) => /^000[1-9]_/.test(f) && !f.endsWith('.down.sql'))
      .sort();
    for (const filename of files)
      await pool.query(await readFile(path.join(migrations, filename), 'utf8'));
    await pool.query(
      await readFile(
        path.join(migrations, '0028_phase23_library_relations.sql'),
        'utf8',
      ),
    );
    await pool.query(
      "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English'),('vi','vietnamese','Vietnamese','Vietnamese','Vietnamese')",
    );
    identity = new PostgresIdentityRepository(pool);
    resources = new PostgresLibraryRepository(pool);
    relations = new PostgresLibraryRelationsRepository(pool);
    const profiles = new InMemoryProfileRepository();
    const library = new LibraryService(resources, profiles, {
      findLibraryCandidateById: async () => null,
    });
    service = new LibraryRelationsService(
      library,
      resources,
      relations,
      identity,
      profiles,
      new ConfigService({
        auth: { accessSecret: 'synthetic-sql-related-key' },
      }),
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      try {
        if (!/^phase23_test_[a-f0-9]{32}$/.test(schema))
          throw new Error('Unsafe cleanup');
        await admin.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
        expect(
          (
            await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [
              schema,
            ])
          ).rowCount,
        ).toBe(0);
      } finally {
        await admin.end();
      }
    }
  });
  async function fixture() {
    const reviewer = await identity.createUser({
      email: randomUUID() + '@phase23.invalid',
      displayName: 'Synthetic reviewer',
      passwordHash: null,
      status: 'ACTIVE',
    });
    await identity.replaceUserRoles(reviewer.id, ['MODERATOR']);
    await resources.upsertLicense({
      licenseKey: 'TEST-V1',
      displayName: 'Synthetic test license',
      canonicalUrl: 'https://example.test/license',
      attributionRequired: true,
      redistributionAllowed: true,
      derivativeConstraints: null,
      active: true,
      sourceNote: null,
    });
    async function resource(term: string) {
      const r = await resources.createResource({
        createdByUserId: reviewer.id,
        createdAt: new Date(),
        resourceType: 'VOCABULARY',
        primaryLanguageCode: 'en',
        secondaryLanguageCode: null,
        cefrLevel: 'A1',
        topics: [],
        visibility: 'PUBLIC',
        details: {
          resourceType: 'VOCABULARY',
          term,
          definition: 'Synthetic',
          partOfSpeech: null,
          exampleSentence: null,
        },
      });
      await resources.addProvenance(
        r.id,
        {
          sourceType: 'MANUAL_ENTRY',
          sourceId: 'synthetic:' + r.id,
          sourceUrl: null,
          licenseKey: 'TEST-V1',
          attribution: 'Synthetic SQL fixture',
          originalAuthorReference: null,
          originalContributorUserId: null,
          importBatch: null,
          transformationHistory: [],
          sourcePostId: null,
          sourceResponseId: null,
          sourceCandidateId: null,
          sourceAcceptanceId: null,
        },
        { expectedReviewState: 'DRAFT', expectedProvenanceRevision: 0 },
      );
      await pool.query(
        "UPDATE library_resources SET review_state='VERIFIED',reviewed_by_user_id=$2,reviewed_at=now() WHERE id=$1",
        [r.id, reviewer.id],
      );
      return r;
    }
    const anchor = await resource('anchor'),
      target = await resource('target');
    const input = {
      anchorId: anchor.id,
      targetId: target.id,
      type: 'SAME_CONCEPT' as const,
      evidenceReference: 'synthetic:SQL:review',
    };
    return { reviewer, anchor, target, input, resource };
  }
  it('persists explicit review, hydrates canonical target in batches and observes revoke/re-review', async () => {
    const f = await fixture();
    const first = await service.review(f.reviewer.id, f.input);
    expect((await service.list(f.anchor.id, {})).items[0].resource.id).toBe(
      f.target.id,
    );
    await service.revoke(f.reviewer.id, f.input);
    expect((await service.list(f.anchor.id, {})).items).toEqual([]);
    expect((await service.review(f.reviewer.id, f.input)).revision).toBe(
      first.revision + 2,
    );
    await identity.replaceUserRoles(f.reviewer.id, ['MEMBER']);
    expect((await service.list(f.anchor.id, {})).items).toEqual([]);
  });
  it('enforces SQL self/type/evidence/fingerprint/revision and reviewer foreign-key guards', async () => {
    const f = await fixture();
    await service.review(f.reviewer.id, f.input);
    for (const set of [
      'target_resource_id=anchor_resource_id',
      "relation_type='INFERRED'",
      "evidence_reference=''",
      "target_snapshot='invalid'",
      'revision=0',
    ]) {
      await expect(
        pool.query(
          'UPDATE library_resource_relations SET ' +
            set +
            ' WHERE anchor_resource_id=$1',
          [f.anchor.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      pool.query('UPDATE library_resource_relations SET reviewer_user_id=$2 WHERE anchor_resource_id=$1', [f.anchor.id, randomUUID()]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      pool.query('DELETE FROM users WHERE id=$1', [f.reviewer.id]),
    ).rejects.toMatchObject({ code: '23001' });
    expect(await identity.findUserById(f.reviewer.id)).not.toBeNull();
    expect(await relations.findForTargets(f.anchor.id, [f.target.id])).toHaveLength(1);
  });
  it('invalidates changed endpoint snapshots and cascades only hard-deleted endpoint assertions', async () => {
    const f = await fixture();
    await service.review(f.reviewer.id, f.input);
    await pool.query(
      "UPDATE library_vocabularies SET term='changed synthetic' WHERE resource_id=$1",
      [f.target.id],
    );
    expect((await service.list(f.anchor.id, {})).items).toEqual([]);
    await service.review(f.reviewer.id, f.input);
    await pool.query('DELETE FROM library_resources WHERE id=$1', [
      f.target.id,
    ]);
    expect(await relations.findForTargets(f.anchor.id, [f.target.id])).toEqual(
      [],
    );
    expect((await service.list(f.anchor.id, {})).items).toEqual([]);
  });
  it('bounds SQL provenance hydration at32 without truncating canonical detail', async () => {
    const f = await fixture();
    await pool.query(
      "UPDATE library_resources SET review_state='DRAFT',reviewed_by_user_id=NULL,reviewed_at=NULL WHERE id=$1",
      [f.target.id],
    );
    await pool.query(
      "INSERT INTO library_resource_provenance(resource_id,source_type,source_id,license_key,attribution) SELECT $1,'MANUAL_ENTRY','bound-'||i,'TEST-V1','Synthetic bound source' FROM generate_series(1,31) i",
      [f.target.id],
    );
    expect(
      (await resources.findResourcesByIds([f.target.id]))[0].provenance,
    ).toHaveLength(32);
    await pool.query(
      "INSERT INTO library_resource_provenance(resource_id,source_type,source_id,license_key,attribution) VALUES($1,'MANUAL_ENTRY','bound-33','TEST-V1','Synthetic bound source')",
      [f.target.id],
    );
    expect(await resources.findResourcesByIds([f.target.id])).toEqual([]);
    expect(
      (await resources.findResourceById(f.target.id))?.provenance,
    ).toHaveLength(33);
  });

  it('executes populated64-target keysets and boolean continuation without repeat or leak', async () => {
    const f = await fixture();
    const targets = [];
    for (let i = 0; i < 65; i++) {
      const target = await f.resource('synthetic-plan-' + i);
      targets.push(target);
      await service.review(f.reviewer.id, { ...f.input, targetId: target.id });
    }
    targets.sort((a, b) => a.id.localeCompare(b.id));
    await pool.query(
      "UPDATE library_resources SET visibility='PRIVATE' WHERE id=ANY($1::uuid[])",
      [targets.slice(0, 64).map((t) => t.id)],
    );
    const first = await service.list(f.anchor.id, {});
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(f.anchor.id, {
      cursor: first.nextCursor!,
    });
    expect(second.items[0].resource.id).toBe(targets[64].id);
    expect(second.nextCursor).toBeNull();
    const plan = await pool.query(
      "EXPLAIN (ANALYZE,FORMAT JSON) SELECT DISTINCT target_resource_id FROM library_resource_relations WHERE anchor_resource_id=$1 AND status='ACTIVE' ORDER BY target_resource_id LIMIT 64",
      [f.anchor.id],
    );
    expect(plan.rows[0]['QUERY PLAN'][0].Plan['Actual Rows']).toBe(64);
  });

  it('rolls down only relation objects and reapplies migration without seeds', async () => {
    await pool.query(
      await readFile(
        path.join(migrations, '0028_phase23_library_relations.down.sql'),
        'utf8',
      ),
    );
    expect(
      (
        await pool.query(
          "SELECT to_regclass('library_resource_relations') AS relation,to_regclass('library_resources') AS resource",
        )
      ).rows[0],
    ).toEqual({ relation: null, resource: 'library_resources' });
    await pool.query(
      await readFile(
        path.join(migrations, '0028_phase23_library_relations.sql'),
        'utf8',
      ),
    );
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM library_resource_relations',
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
