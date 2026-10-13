import { LibraryService } from '../../src/library/library.service';
import { PostgresLibraryRepository } from '../../src/library/postgres-library.repository';
import { PostgresCorrectionsRepository } from '../../src/corrections/postgres-corrections.repository';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { SqlHarness } from '../phase22/sql-harness';
import { StudyGroupService } from '../../src/study-groups/study-group.service';
import { GroupSyncCursor } from '../../src/study-groups/group-sync-cursor';
import { PostgresGroupStreamRepository } from '../../src/study-groups/postgres-group-stream.repository';
import { PostgresMessageStreamRepository } from '../../src/messaging/postgres-message-stream.repository';
import { PostgresDirectConversationRepository } from '../../src/messaging/postgres-direct-conversation.repository';
import { MessageContextResolver } from '../../src/communication/learning-context-resolver';
import { PostgresCommunityRepository } from '../../src/community/postgres-community.repository';
import { PostgresIdentityRepository } from '../../src/identity/postgres-identity.repository';
import { PostgresProfileRepository } from '../../src/profile/postgres-profile.repository';
import { CommunityService } from '../../src/community/community.service';
import { CommunityRateLimiter } from '../../src/community/community.rate-limiter';

describe('Phase27 group collaboration PostgreSQL proof', () => {
  const db = new SqlHarness();
  let groups: StudyGroupService, contexts: MessageContextResolver;
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
          Number(file.slice(0, 4)) <= 38,
      )
      .sort();
    for (const file of files) await db.migration(file);
    const tables = [
      'users',
      'study_groups',
      'study_group_memberships',
      'study_group_texts',
      'direct_message_stream_leases',
      'community_posts',
    ];
    expect(
      (
        await db.pool.query(
          `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname=current_schema() AND c.relname=ANY($1::text[])`,
          [tables],
        )
      ).rows[0].n,
    ).toBe(tables.length);
    contexts = new MessageContextResolver(
      new LibraryService(
        new PostgresLibraryRepository(db.pool),
        new PostgresProfileRepository(db.pool),
        new PostgresCorrectionsRepository(db.pool),
      ),
      new CommunityService(
        new PostgresCommunityRepository(db.pool),
        new PostgresProfileRepository(db.pool),
        new PostgresIdentityRepository(db.pool),
        new CommunityRateLimiter(),
      ),
    );
    groups = new StudyGroupService(
      db.pool,
      contexts,
      new GroupSyncCursor('synthetic-group-sql-secret-at-least-32'),
    );
  }, 180000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
  });
  async function fixture() {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of [a, b, c])
      await db.pool.query(
        `INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic group actor','ACTIVE',now())`,
        [id, id + '@phase27.invalid'],
      );
    const group = await groups.createGroup(a, {
      name: 'Synthetic collaboration group',
    });
    const invite = await groups.issueInvitation(a, group.id);
    await groups.acceptInvitation(b, {
      groupId: group.id,
      token: invite.token,
    });
    const session = (
      await db.pool.query(
        `INSERT INTO auth_sessions(user_id,family_id,token_digest,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour') RETURNING id`,
        [a, randomUUID(), randomUUID()],
      )
    ).rows[0].id;
    return { a, b, c, group, session };
  }
  it('serializes duplicate sends, preserves flat bounded ordering, unread and monotonic observed reads', async () => {
    const f = await fixture(),
      key = randomUUID();
    const results = await Promise.all([
      groups.createText(f.a, f.group.id, {
        body: 'Hello synthetic members',
        clientMessageId: key,
      }),
      groups.createText(f.a, f.group.id, {
        body: 'Hello synthetic members',
        clientMessageId: key,
      }),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(results[0].sequence).toBe('1');
    await expect(
      groups.createText(f.a, f.group.id, {
        body: 'Different payload',
        clientMessageId: key,
      }),
    ).rejects.toMatchObject({ code: 'GROUP_SEND_CONFLICT' });
    const next = await groups.createText(f.b, f.group.id, {
      body: 'Reply as a flat text',
      clientMessageId: randomUUID(),
    });
    const first = await groups.syncTexts(f.b, f.group.id, { limit: 1 });
    expect(first.items.map((row) => row.id)).toEqual([results[0].id]);
    expect(first.hasMore).toBe(true);
    expect(first.unreadCount).toBe(1);
    const second = await groups.syncTexts(f.b, f.group.id, {
      limit: 1,
      cursor: first.cursor,
      renderedIds: [results[0].id],
    });
    expect(second.items.map((row) => row.id)).toEqual([next.id]);
    expect(second.stillVisibleIds).toEqual([results[0].id]);
    expect(second.hasMore).toBe(false);
    expect(await groups.markRead(f.b, f.group.id, next.id)).toEqual({
      lastReadSequence: '2',
      unreadCount: 0,
    });
    expect(await groups.markRead(f.b, f.group.id, results[0].id)).toEqual({
      lastReadSequence: '2',
      unreadCount: 0,
    });
    await expect(
      groups.markRead(f.b, f.group.id, randomUUID()),
    ).rejects.toMatchObject({ code: 'GROUP_UNAVAILABLE' });
  });
  it('retries an existing send before retained-text capacity but after current ACL', async () => {
    const f = await fixture(),
      key = randomUUID();
    const sent = await groups.createText(f.a, f.group.id, {
      body: 'Idempotent',
      clientMessageId: key,
    });
    await db.pool.query(
      `INSERT INTO study_group_texts(group_id,author_user_id,body) SELECT $1,$2,'Retained fixture text' FROM generate_series(1,19)`,
      [f.group.id, f.a],
    );
    expect(
      (
        await groups.createText(f.a, f.group.id, {
          body: 'Idempotent',
          clientMessageId: key,
        })
      ).id,
    ).toBe(sent.id);
    await expect(
      groups.createText(f.a, f.group.id, {
        body: 'New over capacity',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'GROUP_LIMIT_REACHED' });
    await groups.removeMember(f.a, f.group.id, f.b);
    await expect(
      groups.createText(f.b, f.group.id, {
        body: 'Forbidden retry',
        clientMessageId: key,
      }),
    ).rejects.toMatchObject({ code: 'GROUP_UNAVAILABLE' });
  });
  it('purges hidden rendered texts, advances last scanned position and bumps current role/version', async () => {
    const f = await fixture();
    const first = await groups.createText(f.a, f.group.id, {
        body: 'Hide this',
      }),
      second = await groups.createText(f.a, f.group.id, {
        body: 'Visible later',
      });
    const before = await groups.syncTexts(f.b, f.group.id);
    await groups.hideText(f.a, f.group.id, first.id);
    const after = await groups.syncTexts(f.b, f.group.id, {
      cursor: before.cursor,
      renderedIds: [first.id, second.id],
    });
    expect(after.stillVisibleIds).toEqual([second.id]);
    expect(after.hiddenIds).toEqual([]);
    const owner=await groups.syncTexts(f.a,f.group.id,{cursor:(await groups.syncTexts(f.a,f.group.id)).cursor,renderedIds:[first.id,second.id]});
    expect(owner.items).toHaveLength(0);expect(owner.stillVisibleIds.sort()).toEqual([first.id,second.id].sort());expect(owner.hiddenIds).toEqual([first.id]);
    expect(after.items).toHaveLength(0);
    expect(BigInt(after.version)).toBeGreaterThan(BigInt(before.version));
    expect(after.unreadCount).toBe(1);
    await groups.setRole(f.a, f.group.id, f.b, { role: 'MODERATOR' });
    const promoted = await groups.syncTexts(f.b, f.group.id);
    expect(promoted.groupRole).toBe('MODERATOR');
    expect(promoted.items.find((row) => row.id === first.id)?.hidden).toBe(
      true,
    );
    expect(promoted.unreadCount).toBe(1);
  });
  it('rejects outsiders, foreign group cursor/rendered/read IDs, removal and stale rejoin generation', async () => {
    const f = await fixture(),
      other = await groups.createGroup(f.a, { name: 'Other private group' });
    const text = await groups.createText(f.a, f.group.id, {
        body: 'Protected',
      }),
      foreign = await groups.createText(f.a, other.id, {
        body: 'Other protected',
      });
    await expect(groups.syncTexts(f.c, f.group.id)).rejects.toMatchObject({
      code: 'GROUP_UNAVAILABLE',
    });
    await expect(
      groups.syncTexts(f.b, f.group.id, { renderedIds: [foreign.id] }),
    ).rejects.toMatchObject({ code: 'GROUP_UNAVAILABLE' });
    await expect(
      groups.markRead(f.b, f.group.id, foreign.id),
    ).rejects.toMatchObject({ code: 'GROUP_UNAVAILABLE' });
    const old = await groups.syncTexts(f.b, f.group.id);
    await groups.leaveGroup(f.b, f.group.id);
    const invite = await groups.issueInvitation(f.a, f.group.id);
    await groups.acceptInvitation(f.b, {
      groupId: f.group.id,
      token: invite.token,
    });
    await expect(
      groups.syncTexts(f.b, f.group.id, { cursor: old.cursor }),
    ).rejects.toMatchObject({ code: 'GROUP_INVALID_CURSOR' });
    expect((await groups.syncTexts(f.b, f.group.id)).unreadCount).toBe(0);
    await groups.removeMember(f.a, f.group.id, f.b);
    await expect(groups.syncTexts(f.b, f.group.id)).rejects.toMatchObject({
      code: 'GROUP_UNAVAILABLE',
    });
    await expect(
      groups.getTextContext(f.b, f.group.id, text.id),
    ).rejects.toMatchObject({ code: 'GROUP_UNAVAILABLE' });
  });
  it('stores only canonical references and reprojects current public Community context', async () => {
    const f = await fixture();
    const language = (
      await db.pool.query(
        `INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id`,
      )
    ).rows[0].id;
    const post = (
      await db.pool.query(
        `INSERT INTO community_posts(author_user_id,target_language_id,post_type,content,visibility) VALUES($1,$2,'DISCUSSION','Canonical synthetic context','PUBLIC') RETURNING id`,
        [f.a, language],
      )
    ).rows[0].id;
    const text = await groups.createText(f.a, f.group.id, {
      contextType: 'COMMUNITY_POST',
      contextId: post,
      clientMessageId: randomUUID(),
    });
    expect(text.body).toBe('');
    expect(text.context).toMatchObject({ availability: 'AVAILABLE', id: post });
    expect(await groups.getTextContext(f.b, f.group.id, text.id)).toMatchObject(
      { textId: text.id, context: { availability: 'AVAILABLE' } },
    );
    await db.pool.query(
      `UPDATE community_posts SET visibility='PRIVATE' WHERE id=$1`,
      [post],
    );
    expect(await groups.getTextContext(f.b, f.group.id, text.id)).toEqual({
      textId: text.id,
      context: { availability: 'UNAVAILABLE' },
    });
    await expect(
      groups.createText(f.a, f.group.id, {
        contextType: 'COMMUNITY_POST',
        contextId: post,
      }),
    ).rejects.toMatchObject({ code: 'GROUP_CONTEXT_UNAVAILABLE' });
  });
  it.each([
    { context_type: null, context_id: randomUUID() },
    { context_type: 'COMMUNITY_POST', context_id: null },
  ])('rejects an unpaired persisted context %p', async (input) => {
    const f = await fixture();
    await db.invalidCommit(
      'INSERT INTO study_group_texts(group_id,author_user_id,body,context_type,context_id) VALUES($1,$2,$3,$4,$5)',
      [f.group.id, f.a, 'Note', input.context_type, input.context_id],
      '23514',
    );
  });
  it('shares the actor-wide ten-lease capacity with real direct stream acquisition', async () => {
    const f = await fixture();
    const language = (
      await db.pool.query(
        `INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id`,
      )
    ).rows[0].id;
    for (const actor of [f.a, f.b]) {
      await db.pool.query(
        `INSERT INTO language_exchange_preferences(user_id,exchange_opt_in,contact_permission) VALUES($1,true,'RELATIONSHIP_GATED')`,
        [actor],
      );
      const relation = (
        await db.pool.query(
          `INSERT INTO user_languages(user_id,language_id,is_known,is_learning,declared_proficiency) VALUES($1,$2,true,true,'B1') RETURNING id`,
          [actor, language],
        )
      ).rows[0].id;
      await db.pool.query(
        `INSERT INTO language_exchange_languages(user_id,user_language_id,direction) VALUES($1,$2,'OFFER'),($1,$2,'WANT')`,
        [actor, relation],
      );
    }
    await db.pool.query(
      `INSERT INTO language_exchange_connections(participant_a_id,participant_b_id,requester_id,status) VALUES($1,$2,$1,'CONNECTED')`,
      [f.a, f.b],
    );
    const conversations = new PostgresDirectConversationRepository(db.pool),
      conversation = await conversations.open(f.a, f.b),
      direct = new PostgresMessageStreamRepository(db.pool, conversations),
      groupStreams = new PostgresGroupStreamRepository(db.pool);
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        index % 2
          ? direct.acquire(f.a, conversation.id, f.session)
          : groupStreams.acquire(f.a, f.group.id, f.session),
      ),
    );
    expect(attempts.filter((row) => row.status === 'fulfilled')).toHaveLength(
      10,
    );
    expect(attempts.filter((row) => row.status === 'rejected')).toHaveLength(2);
    const groupLease = attempts
      .filter((row) => row.status === 'fulfilled')
      .map(
        (row) =>
          (
            row as PromiseFulfilledResult<
              Awaited<ReturnType<typeof groupStreams.acquire>>
            >
          ).value,
      )
      .find((row) => row.conversationId === f.group.id)!;
    expect(await groupStreams.poll(groupLease)).toMatch(/^\d+$/);
    await groups.archiveGroup(f.a, f.group.id);
    await expect(groupStreams.poll(groupLease)).rejects.toMatchObject({
      code: 'GROUP_UNAVAILABLE',
    });
    await groupStreams.release(groupLease);
  });
  it('backfills deterministic text sequences and initializes existing member read head without data loss', async () => {
    const f = await fixture();
    const first = await groups.createText(f.a, f.group.id, {
        body: 'Retained first',
      }),
      second = await groups.createText(f.a, f.group.id, {
        body: 'Retained second',
      });
    await db.migration('0038_phase27_group_collaboration.down.sql');
    await db.migration('0038_phase27_group_collaboration.sql');
    const rows = (
      await db.pool.query(
        'SELECT id,body,sequence FROM study_group_texts WHERE group_id=$1 ORDER BY sequence',
        [f.group.id],
      )
    ).rows;
    expect(rows).toEqual([
      { id: first.id, body: 'Retained first', sequence: '1' },
      { id: second.id, body: 'Retained second', sequence: '2' },
    ]);
    expect((await groups.syncTexts(f.b, f.group.id)).unreadCount).toBe(0);
    expect(
      (
        await db.pool.query(
          'SELECT read_sequence FROM study_group_memberships WHERE group_id=$1',
          [f.group.id],
        )
      ).rows.every((row) => row.read_sequence === '2'),
    ).toBe(true);
  });
  it('refuses rollback for active group leases and any retained canonical context', async () => {
    const f = await fixture(),
      streams = new PostgresGroupStreamRepository(db.pool),
      lease = await streams.acquire(f.a, f.group.id, f.session);
    await expect(
      db.migration('0038_phase27_group_collaboration.down.sql'),
    ).rejects.toMatchObject({ code: 'P0001' });
    await streams.release(lease);
    await db.pool.query(
      "INSERT INTO study_group_texts(group_id,author_user_id,body,context_type,context_id) VALUES($1,$2,'Keep note and reference','LIBRARY_RESOURCE',$3)",
      [f.group.id, f.a, randomUUID()],
    );
    await expect(
      db.migration('0038_phase27_group_collaboration.down.sql'),
    ).rejects.toMatchObject({ code: 'P0001' });
    expect(
      (
        await db.pool.query(
          'SELECT context_id FROM study_group_texts WHERE group_id=$1',
          [f.group.id],
        )
      ).rows[0].context_id,
    ).toBeTruthy();
  });
  it('uses actual Library canonical eligibility and revokes group previews after license deactivation', async () => {
    const f = await fixture();
    await db.pool.query(
      "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true",
    );
    const repository = new PostgresLibraryRepository(db.pool);
    await repository.upsertLicense({
      licenseKey: 'PHASE27-TEST',
      displayName: 'Synthetic test license',
      canonicalUrl: 'https://example.invalid/license',
      attributionRequired: true,
      redistributionAllowed: true,
      derivativeConstraints: null,
      active: true,
      sourceNote: null,
    });
    const resource = await repository.createResource({
      createdByUserId: f.a,
      createdAt: new Date(),
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'en',
      secondaryLanguageCode: null,
      cefrLevel: 'A1',
      topics: [],
      visibility: 'PUBLIC',
      details: {
        resourceType: 'VOCABULARY',
        term: 'Synthetic word',
        definition: 'Synthetic definition',
        partOfSpeech: null,
        exampleSentence: null,
      },
    });
    await repository.addProvenance(
      resource.id,
      {
        sourceType: 'MANUAL_ENTRY',
        sourceId: 'phase27:' + resource.id,
        sourceUrl: null,
        licenseKey: 'PHASE27-TEST',
        attribution: 'Synthetic fixture',
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
    await db.pool.query(
      "UPDATE library_resources SET review_state='VERIFIED',reviewed_by_user_id=$2,reviewed_at=now() WHERE id=$1",
      [resource.id, f.c],
    );
    const text = await groups.createText(f.a, f.group.id, {
      contextType: 'LIBRARY_RESOURCE',
      contextId: resource.id,
    });
    expect(text.context).toMatchObject({
      availability: 'AVAILABLE',
      id: resource.id,
    });
    await db.pool.query(
      "UPDATE library_licenses SET active=false WHERE license_key='PHASE27-TEST'",
    );
    expect(await groups.getTextContext(f.b, f.group.id, text.id)).toEqual({
      textId: text.id,
      context: { availability: 'UNAVAILABLE' },
    });
    await expect(
      groups.createText(f.a, f.group.id, {
        contextType: 'LIBRARY_RESOURCE',
        contextId: resource.id,
      }),
    ).rejects.toMatchObject({ code: 'GROUP_CONTEXT_UNAVAILABLE' });
  });
  it('reauthorizes group stream session, account and membership on each protected poll', async () => {
    const f = await fixture(),
      streams = new PostgresGroupStreamRepository(db.pool);
    const bsession = (
      await db.pool.query(
        "INSERT INTO auth_sessions(user_id,family_id,token_digest,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour') RETURNING id",
        [f.b, randomUUID(), randomUUID()],
      )
    ).rows[0].id;
    const lease = await streams.acquire(f.b, f.group.id, bsession);
    await groups.removeMember(f.a, f.group.id, f.b);
    await expect(streams.poll(lease)).rejects.toMatchObject({
      code: 'GROUP_UNAVAILABLE',
    });
    const ownerLease = await streams.acquire(f.a, f.group.id, f.session);
    await db.pool.query(
      'UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1',
      [f.session],
    );
    await expect(streams.poll(ownerLease)).rejects.toMatchObject({
      code: 'AUTH_SESSION_EXPIRED',
    });
    await db.pool.query("UPDATE users SET status='DISABLED' WHERE id=$1", [
      f.a,
    ]);
    await expect(streams.poll(ownerLease)).rejects.toMatchObject({
      code: 'GROUP_UNAVAILABLE',
    });
  });
});
