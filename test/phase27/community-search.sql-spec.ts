import { CommunityService } from '../../src/community/community.service';
import { CommunityRateLimiter } from '../../src/community/community.rate-limiter';
import { PostgresIdentityRepository } from '../../src/identity/postgres-identity.repository';
import { PostgresProfileRepository } from '../../src/profile/postgres-profile.repository';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { SqlHarness } from '../phase22/sql-harness';
import { PostgresCommunityRepository } from '../../src/community/postgres-community.repository';
import { normalizeCommunitySearch } from '../../src/community/community-search';
import { communitySearchQuery } from '../../src/community/community-search-query';
import type { CommunityPostListQuery } from '../../src/community/community.repository';

describe('Phase27 database Community search', () => {
  const db = new SqlHarness();
  let repo: PostgresCommunityRepository;
  beforeAll(async () => {
    await db.open();
    await db.migration('0027_phase22_study_groups.down.sql');
    const files = (
      await readdir(path.resolve(__dirname, '../../database/migrations'))
    )
      .filter(
        (file) =>
          /^\d{4}_[\w-]+\.sql$/.test(file) &&
          Number(file.slice(0, 4)) >= 2 &&
          Number(file.slice(0, 4)) <= 36,
      )
      .sort();
    for (const file of files) await db.migration(file);
    const tables = [
      'users',
      'languages',
      'community_posts',
      'community_reactions',
      'community_saved_posts',
      'community_structured_responses',
      'community_structured_response_acceptances',
    ];
    expect(
      (
        await db.pool.query(
          `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname=current_schema() AND c.relname=ANY($1::text[])`,
          [tables],
        )
      ).rows[0].n,
    ).toBe(tables.length);
    repo = new PostgresCommunityRepository(db.pool);
  }, 180000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
  });
  async function actors() {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < ids.length; i++)
      await db.pool.query(
        `INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic search actor',$3::user_status,CASE WHEN $3::text='ACTIVE' THEN now() ELSE NULL END)`,
        [ids[i], ids[i] + '@phase27.invalid', i === 3 ? 'DISABLED' : 'ACTIVE'],
      );
    const language = (
      await db.pool.query(
        `INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id`,
      )
    ).rows[0].id;
    return { ids, language };
  }
  async function post(
    author: string,
    language: string,
    input: {
      type?: string;
      content?: string;
      topic?: string;
      visibility?: string;
      state?: string;
      time?: string;
    } = {},
  ) {
    return (
      await db.pool.query(
        `INSERT INTO community_posts(author_user_id,target_language_id,post_type,content,topic,visibility,moderation_state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,now())) RETURNING id`,
        [
          author,
          language,
          input.type ?? 'QUESTION',
          input.content ?? 'Synthetic practice question',
          input.topic ?? 'grammar',
          input.visibility ?? 'PUBLIC',
          input.state ?? 'ACTIVE',
          input.time ?? null,
        ],
      )
    ).rows[0].id as string;
  }
  function query(
    input: Parameters<typeof normalizeCommunitySearch>[0] = {},
    actor: string | null = null,
  ): CommunityPostListQuery {
    const search = normalizeCommunitySearch(input);
    return { search, searchActor: actor, limit: search.limit };
  }
  it('records before/after index query cost for 10000 mixed posts and mutable useful keysets', async () => {
    const { ids, language } = await actors();
    await db.pool.query(
      `INSERT INTO community_posts(author_user_id,target_language_id,post_type,content,topic,visibility,moderation_state,created_at)
   SELECT CASE WHEN n%17=0 THEN $2::uuid ELSE $1::uuid END,$3::uuid,CASE WHEN n%3=0 THEN 'DISCUSSION'::community_post_type ELSE 'QUESTION'::community_post_type END,
    CASE WHEN n=9999 THEN 'rare-zebra-needle' ELSE 'common practice language '||n::text END,CASE WHEN n%2=0 THEN 'grammar' ELSE 'writing' END,
    CASE WHEN n%13=0 THEN 'PRIVATE'::community_post_visibility ELSE 'PUBLIC'::community_post_visibility END,
    CASE WHEN n%19=0 THEN 'HIDDEN'::community_moderation_state ELSE 'ACTIVE'::community_moderation_state END,
    '2026-10-13T00:00:00Z'::timestamptz+n*interval '1 microsecond' FROM generate_series(1,10000)n`,
      [ids[0], ids[3], language],
    );
    await db.pool.query(
      `INSERT INTO community_reactions(post_id,user_id,reaction_type) SELECT p.id,u.id,'HELPFUL' FROM community_posts p CROSS JOIN users u WHERE u.id=ANY($1::uuid[]) AND abs(hashtext(p.id::text)::bigint)%4>array_position($1::uuid[],u.id)-1`,
      [ids.slice(0, 3)],
    );
    await db.pool.query(
      `INSERT INTO community_saved_posts(post_id,user_id) SELECT id,$1 FROM community_posts WHERE topic='grammar'`,
      [ids[0]],
    );
    await db.pool.query(
      `INSERT INTO community_structured_responses(parent_post_id,author_user_id,response_kind,answer_text) SELECT id,$1,'QA_ANSWER','Synthetic eligible answer' FROM community_posts WHERE post_type='QUESTION' AND topic='grammar'`,
      [ids[1]],
    );
    await db.pool.query(
      `INSERT INTO community_structured_response_acceptances(parent_post_id,response_id,accepted_by_user_id) SELECT r.parent_post_id,r.id,p.author_user_id FROM community_structured_responses r JOIN community_posts p ON p.id=r.parent_post_id WHERE p.moderation_state='ACTIVE'`,
    );
    await db.pool.query(
      'ANALYZE community_posts; ANALYZE community_reactions; ANALYZE community_structured_responses; ANALYZE community_saved_posts; ANALYZE community_structured_response_acceptances',
    );
    const cases = [
      query(),
      query({ q: 'a' }),
      query({ q: 'common practice' }),
      query({ q: 'no-such-needle' }),
      query({ q: 'rare-zebra-needle' }),
      query({ sort: 'USEFUL', limit: 50 }),
      query(
        {
          sort: 'USEFUL',
          q: 'a',
          postType: 'QUESTION',
          topic: 'grammar',
          languageCode: 'en',
          responseState: 'ACCEPTED',
          savedByMe: 'true',
        },
        ids[0],
      ),
    ];
    cases.push(query({ postType: 'QUESTION', topic: 'grammar', limit: 50 }));
    const usefulPage = await repo.listPosts(query({ sort: 'USEFUL' }));
    cases.push({
      ...query({ sort: 'USEFUL', q: 'common practice' }),
      searchBefore: usefulPage.items.at(-1)!.searchPosition,
    });
    for (const phase of ['BEFORE_INDEXES', 'AFTER_INDEXES']) {
      if (phase === 'AFTER_INDEXES') {
        await db.migration('0037_phase27_community_search.sql');
        await db.pool.query(
          'ANALYZE community_posts; ANALYZE community_structured_responses',
        );
      }
      for (let index = 0; index < cases.length; index++) {
        const built = communitySearchQuery(cases[index]);
        const plan = (
          await db.pool.query(
            'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + built.text,
            built.values,
          )
        ).rows[0]['QUERY PLAN'][0];
        const indexes: string[] = [];
        const visit = (node: Record<string, unknown>) => {
          if (node['Index Name']) indexes.push(String(node['Index Name']));
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            visit(child);
        };
        visit(plan.Plan);
        console.log(
          JSON.stringify({
            phase,
            case: index,
            executionMs: plan['Execution Time'],
            planningMs: plan['Planning Time'],
            indexes: [...new Set(indexes)],
            sharedHits: plan.Plan['Shared Hit Blocks'],
            sharedReads: plan.Plan['Shared Read Blocks'],
          }),
        );
        if (phase === 'AFTER_INDEXES')
          expect(
            Number(plan['Execution Time']) + Number(plan['Planning Time']),
          ).toBeLessThan(1000);
      }
    }

    let roundTrips = 0;
    const instrumented = {
      connect: async () => {
        const client = await db.pool.connect();
        return {
          query: (sql: string, values?: unknown[]) => {
            roundTrips++;
            return client.query(sql, values);
          },
          release: () => client.release(),
        };
      },
    } as unknown as Pool;
    const service = new CommunityService(
      new PostgresCommunityRepository(instrumented),
      new PostgresProfileRepository(db.pool),
      new PostgresIdentityRepository(db.pool),
      new CommunityRateLimiter(),
    );
    const started = performance.now();
    const complete = await service.listPosts({ sort: 'USEFUL', limit: 50 });
    const elapsedMs = performance.now() - started;
    expect(complete.items).toHaveLength(50);
    expect(roundTrips).toBeLessThanOrEqual(8);
    console.log(
      JSON.stringify({
        phase: 'COMPLETE_SERVICE_PAGE',
        limit: 50,
        items: complete.items.length,
        roundTrips,
        elapsedMs,
      }),
    );
  }, 180000);
  it('applies literal text, combined filters and complete author/visibility checks before pagination', async () => {
    const { ids, language } = await actors();
    const eligible = await post(ids[0], language, {
      content: 'Literal 100%_\\ value',
      topic: 'grammar',
    });
    await post(ids[0], language, { content: 'Literal 100XX value' });
    await post(ids[0], language, {
      content: 'Literal 100%_\\ value',
      visibility: 'PRIVATE',
    });
    await post(ids[3], language, { content: 'Literal 100%_\\ value' });
    await post(ids[0], language, {
      content: 'Literal 100%_\\ value',
      state: 'HIDDEN',
    });
    expect(
      (
        await repo.listPosts(
          query({
            q: '100%_\\',
            postType: 'QUESTION',
            topic: 'grammar',
            languageCode: 'en',
            limit: 1,
          }),
        )
      ).items.map((row) => row.id),
    ).toEqual([eligible]);
  });
  it('paginates distinct timestamps within one millisecond without duplicates or omissions', async () => {
    const { ids, language } = await actors();
    const expected = [];
    for (const micros of ['123001', '123002', '123003', '123004'])
      expected.push(
        await post(ids[0], language, {
          time: '2026-10-13T00:00:00.' + micros + 'Z',
        }),
      );
    const first = await repo.listPosts(query({ limit: 2 }));
    const second = await repo.listPosts({
      ...query({ limit: 2 }),
      searchBefore: first.items.at(-1)!.searchPosition,
    });
    expect([...first.items, ...second.items].map((row) => row.id)).toEqual(
      expected.reverse(),
    );
    expect(second.hasMore).toBe(false);
  });
  it('counts only eligible answers/current acceptance and reacts to moderation or responder disable', async () => {
    const { ids, language } = await actors();
    const target = await post(ids[0], language);
    const unanswered = await post(ids[0], language);
    const response = (
      await db.pool.query(
        `INSERT INTO community_structured_responses(parent_post_id,author_user_id,response_kind,answer_text) VALUES($1,$2,'QA_ANSWER','Synthetic answer') RETURNING id`,
        [target, ids[1]],
      )
    ).rows[0].id;
    expect(
      (await repo.listPosts(query({ responseState: 'UNANSWERED' }))).items.map(
        (row) => row.id,
      ),
    ).toEqual([unanswered]);
    expect(
      (await repo.listPosts(query({ responseState: 'ANSWERED' }))).items.map(
        (row) => row.id,
      ),
    ).toEqual([target]);
    await db.pool.query(
      'INSERT INTO community_structured_response_acceptances(parent_post_id,response_id,accepted_by_user_id) VALUES($1,$2,$3)',
      [target, response, ids[0]],
    );
    expect(
      (await repo.listPosts(query({ responseState: 'ACCEPTED' }))).items.map(
        (row) => row.id,
      ),
    ).toEqual([target]);
    await db.pool.query(`UPDATE users SET status='DISABLED' WHERE id=$1`, [
      ids[1],
    ]);
    expect(
      (await repo.listPosts(query({ responseState: 'ACCEPTED' }))).items,
    ).toHaveLength(0);
    await db.pool.query(`UPDATE users SET status='ACTIVE' WHERE id=$1`, [
      ids[1],
    ]);
    await db.pool.query(
      `UPDATE community_structured_responses SET moderation_state='HIDDEN' WHERE id=$1`,
      [response],
    );
    expect(
      (await repo.listPosts(query({ responseState: 'ANSWERED' }))).items,
    ).toHaveLength(0);
  });
  it('combines saved scope with public-only search and current verified actor', async () => {
    const { ids, language } = await actors();
    const publicId = await post(ids[0], language);
    const privateId = await post(ids[0], language, { visibility: 'PRIVATE' });
    await db.pool.query(
      'INSERT INTO community_saved_posts(post_id,user_id) VALUES($1,$3),($2,$3)',
      [publicId, privateId, ids[0]],
    );
    expect(
      (await repo.listPosts(query({ savedByMe: 'true' }, ids[0]))).items.map(
        (row) => row.id,
      ),
    ).toEqual([publicId]);
    expect(
      (await repo.listPosts(query({ savedByMe: 'true' }, ids[1]))).items,
    ).toHaveLength(0);
    await db.pool.query('UPDATE users SET email_verified_at=NULL WHERE id=$1', [
      ids[0],
    ]);
    expect(
      (await repo.listPosts(query({ savedByMe: 'true' }, ids[0]))).items,
    ).toHaveLength(0);
  });
  it('uses current post helpful score and exclusive useful keysets', async () => {
    const { ids, language } = await actors();
    const high = await post(ids[0], language, {
      time: '2026-10-13T00:00:00.000001Z',
    });
    const low = await post(ids[0], language, {
      time: '2026-10-13T00:00:00.000002Z',
    });
    await db.pool.query(
      `INSERT INTO community_reactions(post_id,user_id,reaction_type) VALUES($1,$2,'HELPFUL'),($1,$3,'HELPFUL')`,
      [high, ids[1], ids[2]],
    );
    const first = await repo.listPosts(query({ sort: 'USEFUL', limit: 1 }));
    expect(first.items[0].id).toBe(high);
    const second = await repo.listPosts({
      ...query({ sort: 'USEFUL', limit: 1 }),
      searchBefore: first.items[0].searchPosition,
    });
    expect(second.items[0].id).toBe(low);
  });
  it('maps an actual PostgreSQL statement timeout to safe retry without partial output', async () => {
    const actual = await db.pool.connect();
    const wrapper = {
      connect: async () => ({
        query: (sql: string, values?: unknown[]) =>
          sql.startsWith('SELECT p.*')
            ? actual.query('SELECT pg_sleep(1.2)')
            : actual.query(sql, values),
        release: () => actual.release(),
      }),
    } as unknown as Pool;
    await expect(
      new PostgresCommunityRepository(wrapper).listPosts(query()),
    ).rejects.toMatchObject({ code: 'COMMUNITY_SEARCH_RETRY' });
  });
  it.each([
    'DISCUSSION',
    'QUESTION',
    'RESOURCE',
    'LEARNING_JOURNAL',
    'CULTURE',
    'PRONUNCIATION_REQUEST',
    'CORRECTION_REQUEST',
    'CHALLENGE',
  ])('filters exact persisted post type %s', async (type) => {
    const { ids, language } = await actors();
    const selected = await post(ids[0], language, { type });
    await post(ids[1], language, {
      type: type === 'QUESTION' ? 'DISCUSSION' : 'QUESTION',
    });
    expect(
      (await repo.listPosts(query({ postType: type }))).items.map(
        (row) => row.id,
      ),
    ).toEqual([selected]);
  });
  it.each(['UNVERIFIED_PARENT', 'INACTIVE_LANGUAGE'])(
    'applies %s eligibility before limit',
    async (kind) => {
      const { ids, language } = await actors();
      await post(ids[0], language);
      if (kind === 'UNVERIFIED_PARENT')
        await db.pool.query(
          'UPDATE users SET email_verified_at=NULL WHERE id=$1',
          [ids[0]],
        );
      else
        await db.pool.query('UPDATE languages SET active=false WHERE id=$1', [
          language,
        ]);
      expect((await repo.listPosts(query({ limit: 1 }))).items).toHaveLength(0);
    },
  );
  it('excludes unverified responders and revoked acceptances from current accepted categorization', async () => {
    const { ids, language } = await actors();
    const target = await post(ids[0], language);
    const response = (
      await db.pool.query(
        `INSERT INTO community_structured_responses(parent_post_id,author_user_id,response_kind,answer_text) VALUES($1,$2,'QA_ANSWER','Synthetic answer') RETURNING id`,
        [target, ids[1]],
      )
    ).rows[0].id;
    await db.pool.query(
      'INSERT INTO community_structured_response_acceptances(parent_post_id,response_id,accepted_by_user_id) VALUES($1,$2,$3)',
      [target, response, ids[0]],
    );
    await db.pool.query('UPDATE users SET email_verified_at=NULL WHERE id=$1', [
      ids[1],
    ]);
    expect(
      (await repo.listPosts(query({ responseState: 'ANSWERED' }))).items,
    ).toHaveLength(0);
    await db.pool.query(
      'UPDATE users SET email_verified_at=now() WHERE id=$1',
      [ids[1]],
    );
    await db.pool.query(
      'UPDATE community_structured_response_acceptances SET revoked_at=now() WHERE response_id=$1',
      [response],
    );
    expect(
      (await repo.listPosts(query({ responseState: 'ACCEPTED' }))).items,
    ).toHaveLength(0);
    expect(
      (await repo.listPosts(query({ responseState: 'ANSWERED' }))).items.map(
        (row) => row.id,
      ),
    ).toEqual([target]);
  });
});
