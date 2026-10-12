import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { StudyGroupService } from '../../src/study-groups/study-group.service';
import { SqlHarness } from '../phase22/sql-harness';

describe('Phase26 connected-partner group invitation PostgreSQL authorization', () => {
  const db = new SqlHarness();
  let groups: StudyGroupService;
  beforeAll(async () => {
    await db.open();
    expect((await db.pool.query(`SELECT extname FROM pg_extension
      WHERE extname IN ('pgcrypto','btree_gist','pg_trgm')`)).rowCount).toBe(3);
    await db.migration('0027_phase22_study_groups.down.sql');
    const files = (await readdir(path.resolve(__dirname, '../../database/migrations')))
      .filter(file => /^\d{4}_[\w-]+\.sql$/.test(file)
        && Number(file.slice(0, 4)) >= 2 && Number(file.slice(0, 4)) <= 36).sort();
    expect(files).toHaveLength(35);
    for (const file of files) await db.migration(file);
    groups = new StudyGroupService(db.pool);
  }, 180000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.reset(); });

  async function user() {
    const id = randomUUID();
    await db.pool.query(`INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at)
      VALUES($1,$2,$2,'Synthetic group actor','ACTIVE',now())`, [id, id + '@phase26.invalid']);
    const language = (await db.pool.query(`INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name)
      VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO language_exchange_preferences(user_id,exchange_opt_in,discoverable,contact_permission)
      VALUES($1,true,true,'RELATIONSHIP_GATED')`, [id]);
    const relation = (await db.pool.query(`INSERT INTO user_languages
      (user_id,language_id,is_known,is_learning,declared_proficiency)
      VALUES($1,$2,true,true,'B1') RETURNING id`, [id, language])).rows[0].id;
    await db.pool.query(`INSERT INTO language_exchange_languages(user_id,user_language_id,direction)
      VALUES($1,$2,'OFFER'),($1,$2,'WANT')`, [id, relation]);
    return id;
  }

  async function connect(a: string, b: string) {
    const [first, second] = [a, b].sort();
    await db.pool.query(`INSERT INTO language_exchange_connections
      (participant_a_id,participant_b_id,requester_id,status) VALUES($1,$2,$3,'CONNECTED')`, [first, second, a]);
  }

  async function fixture() {
    const owner = await user(); const partner = await user(); const other = await user();
    await connect(owner, partner);
    const group = await groups.createGroup(owner, { name: 'Private synthetic group', description: 'Private description' });
    return { owner, partner, other, group };
  }

  async function protectedState(groupId: string) {
    return {
      invitations: (await db.pool.query('SELECT * FROM study_group_invitations WHERE group_id=$1 ORDER BY id', [groupId])).rows,
      memberships: (await db.pool.query('SELECT * FROM study_group_memberships WHERE group_id=$1 ORDER BY user_id', [groupId])).rows,
    };
  }

  async function unavailable(operation: Promise<unknown>) {
    await expect(operation).rejects.toMatchObject({ code: 'GROUP_UNAVAILABLE', status: 404 });
  }

  it('issues only an ephemeral bearer token with the existing digest/24-hour shape and grants no partner access', async () => {
    const h = await fixture(); const before = await protectedState(h.group.id);
    // Discoverability is not a contact permission on an already connected pair.
    await db.pool.query('UPDATE language_exchange_preferences SET discoverable=false WHERE user_id=ANY($1::uuid[])', [[h.owner, h.partner]]);
    const invitation = await groups.issueConnectedPartnerInvitation(h.owner, h.group.id, h.partner);
    expect(Object.keys(invitation).sort()).toEqual(['expiresAt', 'id', 'token']);
    expect(invitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const after = await protectedState(h.group.id);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.invitations).toHaveLength(1);
    const row = after.invitations[0];
    expect(row).toMatchObject({ id: invitation.id, issuer_user_id: h.owner,
      token_digest: createHash('sha256').update(invitation.token).digest('hex'), accepted_at: null, revoked_at: null });
    expect(row.expires_at.toISOString()).toBe(invitation.expiresAt);
    expect(Math.abs(row.expires_at.getTime() - row.created_at.getTime() - 24 * 60 * 60 * 1000)).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(after)).not.toContain(invitation.token);
    expect(JSON.stringify(await groups.listInvitations(h.owner, h.group.id))).not.toContain(invitation.token);
    await unavailable(groups.getGroup(h.partner, h.group.id));
    await unavailable(groups.listInvitations(h.partner, h.group.id));
    expect((await db.pool.query('SELECT count(*)::int AS count FROM direct_messages')).rows[0].count).toBe(0);
    expect(JSON.stringify((await db.pool.query('SELECT * FROM notifications')).rows)).not.toContain(invitation.token);
  });

  it.each(['pending', 'removed', 'owner-block', 'partner-block', 'owner-no-contact', 'partner-no-contact',
    'owner-opt-out', 'partner-opt-out', 'unverified-owner', 'unverified-partner', 'disabled-partner',
    'private-owner-language', 'private-partner-language', 'missing-offer', 'archived', 'self', 'unrelated'] as const)
  ('denies %s without issuing a secret or changing membership', async reason => {
    const h = await fixture(); let target = h.partner;
    if (reason === 'pending') await db.pool.query("UPDATE language_exchange_connections SET status='PENDING'");
    if (reason === 'removed') await db.pool.query('DELETE FROM language_exchange_connections');
    if (reason === 'owner-block' || reason === 'partner-block') {
      const [a, b] = reason === 'owner-block' ? [h.owner, h.partner] : [h.partner, h.owner];
      await db.pool.query('INSERT INTO language_exchange_blocks(blocker_user_id,blocked_user_id) VALUES($1,$2)', [a, b]);
    }
    if (reason.endsWith('no-contact')) await db.pool.query("UPDATE language_exchange_preferences SET contact_permission='NO_CONTACT' WHERE user_id=$1",
      [reason.startsWith('owner') ? h.owner : h.partner]);
    if (reason.endsWith('opt-out')) await db.pool.query('UPDATE language_exchange_preferences SET exchange_opt_in=false WHERE user_id=$1',
      [reason.startsWith('owner') ? h.owner : h.partner]);
    if (reason.startsWith('unverified')) await db.pool.query('UPDATE users SET email_verified_at=null WHERE id=$1',
      [reason.endsWith('owner') ? h.owner : h.partner]);
    if (reason === 'disabled-partner') await db.pool.query("UPDATE users SET status='DISABLED' WHERE id=$1", [h.partner]);
    if (reason.startsWith('private')) await db.pool.query("UPDATE user_languages SET visibility='PRIVATE' WHERE user_id=$1",
      [reason.includes('owner') ? h.owner : h.partner]);
    if (reason === 'missing-offer') await db.pool.query("DELETE FROM language_exchange_languages WHERE user_id=$1 AND direction='OFFER'", [h.partner]);
    if (reason === 'archived') await groups.archiveGroup(h.owner, h.group.id);
    if (reason === 'self') target = h.owner;
    if (reason === 'unrelated') target = h.other;
    const before = await protectedState(h.group.id);
    await unavailable(groups.issueConnectedPartnerInvitation(h.owner, h.group.id, target));
    expect(await protectedState(h.group.id)).toEqual(before);
  });

  it.each(['MODERATOR', 'MEMBER', 'unrelated', 'former-owner'] as const)
  ('denies a %s issuer even when that issuer has an eligible connected partner', async role => {
    const h = await fixture();
    await connect(h.other, h.partner);
    if (role !== 'unrelated') {
      const token = await groups.issueInvitation(h.owner, h.group.id);
      await groups.acceptInvitation(h.other, { groupId: h.group.id, token: token.token });
      if (role === 'MODERATOR') await groups.setRole(h.owner, h.group.id, h.other, { role: 'MODERATOR' });
    }
    let actor = h.other;
    if (role === 'former-owner') {
      await groups.transferOwnership(h.owner, h.group.id, { userId: h.other }); actor = h.owner;
    }
    const before = await protectedState(h.group.id);
    await unavailable(groups.issueConnectedPartnerInvitation(actor, h.group.id, h.partner));
    expect(await protectedState(h.group.id)).toEqual(before);
  });

  it('preserves the unbound one-use bearer acceptance and does not revoke membership after a block', async () => {
    const h = await fixture();
    const invitation = await groups.issueConnectedPartnerInvitation(h.owner, h.group.id, h.partner);
    const second = await groups.issueConnectedPartnerInvitation(h.owner, h.group.id, h.partner);
    await db.pool.query('INSERT INTO language_exchange_blocks(blocker_user_id,blocked_user_id) VALUES($1,$2)', [h.owner, h.partner]);
    // The selected partner is a convenience check, not a new binding on the Phase22 bearer.
    await groups.acceptInvitation(h.other, { groupId: h.group.id, token: invitation.token });
    await unavailable(groups.acceptInvitation(h.partner, { groupId: h.group.id, token: invitation.token }));
    expect(await groups.getGroup(h.other, h.group.id)).toMatchObject({ id: h.group.id, role: 'MEMBER' });
    await groups.acceptInvitation(h.partner, { groupId: h.group.id, token: second.token });
    await db.pool.query('INSERT INTO language_exchange_blocks(blocker_user_id,blocked_user_id) VALUES($1,$2)', [h.partner, h.owner]);
    expect(await groups.getGroup(h.partner, h.group.id)).toMatchObject({ id: h.group.id, role: 'MEMBER' });
    expect((await db.pool.query('SELECT accepted_by_user_id FROM study_group_invitations WHERE id=$1', [invitation.id])).rows[0])
      .toEqual({ accepted_by_user_id: h.other });
  });

  it('shares the existing 10/minute invitation budget with ordinary owner invitations', async () => {
    const h = await fixture();
    for (let i = 0; i < 9; i++) await groups.issueInvitation(h.owner, h.group.id);
    await groups.issueConnectedPartnerInvitation(h.owner, h.group.id, h.partner);
    const before = await protectedState(h.group.id);
    await expect(groups.issueConnectedPartnerInvitation(h.owner, h.group.id, h.partner))
      .rejects.toMatchObject({ code: 'GROUP_RATE_LIMITED', status: 429 });
    expect(await protectedState(h.group.id)).toEqual(before);
  });

  it('retains the existing 20 total invitation cap, including expired invitation records', async () => {
    const h = await fixture();
    await db.pool.query(`INSERT INTO study_group_invitations(group_id,issuer_user_id,token_digest,created_at,expires_at)
      SELECT $1,$2,encode(digest(gen_random_uuid()::text,'sha256'),'hex'),clock_timestamp()-interval '2 days',
        clock_timestamp()-interval '1 day' FROM generate_series(1,19)`, [h.group.id, h.owner]);
    await groups.issueConnectedPartnerInvitation(h.owner, h.group.id, h.partner);
    const before = await protectedState(h.group.id);
    await expect(groups.issueConnectedPartnerInvitation(h.owner, h.group.id, h.partner))
      .rejects.toMatchObject({ code: 'GROUP_LIMIT_REACHED', status: 409 });
    expect(await protectedState(h.group.id)).toEqual(before);
  });

  async function observedAccountWait(pid: number, holderPid: number) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = await db.pool.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS waiting', [pid, holderPid]);
      if (result.rows[0]?.waiting) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Connected invitation did not wait for the account authorization barrier');
  }

  it.each(['block', 'ownership-transfer'] as const)
  ('rechecks current %s after an observed independent-pool account-lock wait', async change => {
    const h = await fixture();
    if (change === 'ownership-transfer') {
      const invite = await groups.issueInvitation(h.owner, h.group.id);
      await groups.acceptInvitation(h.other, { groupId: h.group.id, token: invite.token });
    }
    const before = await protectedState(h.group.id);
    // max:1 makes the observed backend the same client used by the pending operation.
    const replica = new Pool({ connectionString: db.scopedUrl, max: 1 });
    const holder = await db.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const pid = Number((await replica.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await holder.query('BEGIN');
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await holder.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[h.owner, h.partner, h.other]]);
      pending = new StudyGroupService(replica).issueConnectedPartnerInvitation(h.owner, h.group.id, h.partner)
        .then((value: unknown) => ({ value }), (error: unknown) => ({ error }));
      await observedAccountWait(pid, holderPid);
      if (change === 'block') {
        // Retain CONNECTED to prove that block itself, not removal, denies the issue.
        await holder.query('INSERT INTO language_exchange_blocks(blocker_user_id,blocked_user_id) VALUES($1,$2)', [h.partner, h.owner]);
      } else {
        await holder.query("SELECT id FROM study_groups WHERE id=$1 FOR UPDATE", [h.group.id]);
        await holder.query("UPDATE study_group_memberships SET role='MEMBER' WHERE group_id=$1 AND user_id=$2", [h.group.id, h.owner]);
        await holder.query("UPDATE study_group_memberships SET role='OWNER' WHERE group_id=$1 AND user_id=$2", [h.group.id, h.other]);
        await holder.query('UPDATE study_groups SET owner_user_id=$2 WHERE id=$1', [h.group.id, h.other]);
      }
      await holder.query('COMMIT');
      expect(await pending).toMatchObject({ error: { code: 'GROUP_UNAVAILABLE', status: 404 } });
      const after = await protectedState(h.group.id);
      expect(after.invitations).toEqual(before.invitations);
      if (change === 'block') expect(after.memberships).toEqual(before.memberships);
      else {
        expect(after.memberships.map(row => ({ user: row.user_id, role: row.role }))).toEqual(
          before.memberships.map(row => ({ user: row.user_id, role: row.user_id === h.other ? 'OWNER' : 'MEMBER' })));
      }
    } finally {
      await holder.query('ROLLBACK'); holder.release();
      await pending; await replica.end();
    }
  }, 20000);
});
