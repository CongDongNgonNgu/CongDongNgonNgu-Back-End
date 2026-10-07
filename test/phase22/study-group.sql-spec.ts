import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { StudyGroupService } from '../../src/study-groups/study-group.service';
import { transaction } from '../../src/study-groups/study-group.store';
import { PostgresIdentityRepository } from '../../src/identity/postgres-identity.repository';
import { SqlHarness } from './sql-harness';

describe('Phase22 actual PostgreSQL18 persistence and transactions', () => {
  const db = new SqlHarness();
  let service: StudyGroupService;
  let identity: PostgresIdentityRepository;
  beforeAll(async () => { await db.open(); service = new StudyGroupService(db.pool); identity = new PostgresIdentityRepository(db.pool); });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.reset(); });
  const user = () => identity.createUser({ email: randomUUID() + '@phase22.invalid', displayName: 'Synthetic actor', passwordHash: null, status: 'ACTIVE' });
  async function fixture() {
    const [owner, member, other] = await Promise.all([user(), user(), user()]);
    const group = await service.createGroup(owner.id, { name: 'SQL proof' });
    const invite = await service.issueInvitation(owner.id, group.id);
    await service.acceptInvitation(member.id, { groupId: group.id, token: invite.token });
    return { owner, member, other, group };
  }
  async function ownerInvariant(groupId: string) {
    const result = await db.pool.query(`SELECT g.owner_user_id, m.user_id FROM study_groups g JOIN study_group_memberships m ON m.group_id=g.id WHERE g.id=$1 AND m.role='OWNER' AND m.status='ACTIVE'`, [groupId]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].user_id).toBe(result.rows[0].owner_user_id);
  }
  function processRace(method: string, args: unknown[][]): Promise<{success: boolean;code?:string}[]> {
    let ready = 0;
    const starts: (() => void)[] = [];
    return Promise.all(args.map((entry) => new Promise<{success: boolean;code?:string}>((resolve, reject) => {
      const worker = fork(path.join(__dirname, 'race-worker.cjs'), [], { env: { ...process.env, PHASE22_SCOPED_DATABASE_URL: db.scopedUrl }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const timer = setTimeout(() => { worker.kill(); reject(new Error('Independent worker timeout')); }, 20000);
      worker.on('message', (value: {ready?: boolean; success: boolean;code?:string}) => {
        if (value.ready) { starts.push(() => worker.send({ method, args: entry })); if (++ready === args.length) starts.forEach(start => start()); }
        else { clearTimeout(timer); resolve(value); }
      });
      worker.on('error', reject);
      worker.on('exit', (code) => { if (code) { clearTimeout(timer); reject(new Error('Independent worker failed')); } });
    })));
  }
  async function waitForLock(applicationName: string): Promise<void> {
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      const result=await db.pool.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type=\'Lock\'',[applicationName]);
      if(result.rowCount) return;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    throw new Error('Expected independent PostgreSQL lock wait was not observed');
  }

  it('uses actual READ COMMITTED transactions even when a connection defaults to REPEATABLE READ', async () => {
    const isolationPool=new Pool({connectionString:db.scopedUrl,max:1});
    try {
      await isolationPool.query('SET default_transaction_isolation=\'repeatable read\'');
      const inherited=(await isolationPool.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation;
      expect(inherited).toBe('repeatable read');
      const effective=await transaction(isolationPool,async client=>(await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation);
      expect(effective).toBe('read committed');
    } finally {await isolationPool.end();}
  });

  it('stores only digest and atomically consumes one invitation across independent processes', async () => {
    const [owner, a, b] = await Promise.all([user(), user(), user()]);
    const group = await service.createGroup(owner.id, { name: 'Race' });
    const invite = await service.issueInvitation(owner.id, group.id);
    const stored = await db.pool.query('SELECT * FROM study_group_invitations WHERE id=$1', [invite.id]);
    expect(stored.rows[0].token_digest === createHash('sha256').update(invite.token).digest('hex')).toBe(true);
    expect(Object.values(stored.rows[0]).includes(invite.token)).toBe(false);
    const outcomes = await processRace('acceptInvitation', [a,b].map(actor => [actor.id, {groupId:group.id, token:invite.token}]));
    expect(outcomes.filter(value => value.success)).toHaveLength(1);
    expect(outcomes.filter(value => !value.success)).toEqual([{success:false,code:'GROUP_UNAVAILABLE'}]);
    const members = await db.pool.query('SELECT user_id FROM study_group_memberships WHERE group_id=$1 AND role=\'MEMBER\'', [group.id]);
    expect(members.rowCount).toBe(1);
    expect((await db.pool.query('SELECT accepted_at,accepted_by_user_id FROM study_group_invitations WHERE id=$1', [invite.id])).rows[0]).toMatchObject({accepted_by_user_id:members.rows[0].user_id});
    await expect(service.acceptInvitation(a.id, {groupId:group.id,token:invite.token})).rejects.toMatchObject({code:'GROUP_UNAVAILABLE'});
  });

  it('prevents duplicate membership for concurrent distinct invitations', async () => {
    const [owner, joiner] = await Promise.all([user(), user()]);
    const group = await service.createGroup(owner.id, {name:'Unique'});
    const a = await service.issueInvitation(owner.id, group.id);
    const b = await service.issueInvitation(owner.id, group.id);
    const results = await Promise.allSettled([a,b].map(invite => service.acceptInvitation(joiner.id,{groupId:group.id,token:invite.token})));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'GROUP_UNAVAILABLE'}});
    expect((await db.pool.query('SELECT 1 FROM study_group_memberships WHERE group_id=$1 AND user_id=$2',[group.id,joiner.id])).rowCount).toBe(1);
    expect((await db.pool.query('SELECT 1 FROM study_group_invitations WHERE group_id=$1 AND accepted_at IS NOT NULL',[group.id])).rowCount).toBe(1);
  });

  it('serializes competing ownership transfers and prevents owner leave/removal', async () => {
    const {owner,member,other,group} = await fixture();
    const invitation = await service.issueInvitation(owner.id,group.id);
    await service.acceptInvitation(other.id,{groupId:group.id,token:invitation.token});
    await expect(service.leaveGroup(owner.id,group.id)).rejects.toMatchObject({code:'GROUP_UNAVAILABLE'});
    await expect(service.removeMember(owner.id,group.id,owner.id)).rejects.toMatchObject({code:'GROUP_UNAVAILABLE'});
    const outcomes = await processRace('transferOwnership', [member,other].map(target=>[owner.id,group.id,{userId:target.id}]));
    expect(outcomes.filter(r=>r.success)).toHaveLength(1);
    expect(outcomes.filter(value => !value.success)).toEqual([{success:false,code:'GROUP_UNAVAILABLE'}]);
    await ownerInvariant(group.id);
  });

  it('enforces owner/member/digest and field invariants on direct SQL commits', async () => {
    const {owner,member,other,group} = await fixture();
    await db.invalidCommit('INSERT INTO study_group_memberships(group_id,user_id,role,status) VALUES($1,$2,\'MEMBER\',\'ACTIVE\')',[group.id,member.id],'23505');
    await db.invalidCommit('UPDATE study_group_memberships SET role=\'OWNER\' WHERE group_id=$1 AND user_id=$2',[group.id,member.id],'23505');
    await db.invalidCommit('UPDATE study_group_memberships SET role=\'MEMBER\' WHERE group_id=$1 AND user_id=$2',[group.id,owner.id],'23503');
    await db.invalidCommit('UPDATE study_groups SET owner_user_id=$2 WHERE id=$1',[group.id,other.id],'23503');
    await db.invalidCommit('UPDATE study_group_memberships SET status=\'LEFT\' WHERE group_id=$1 AND user_id=$2',[group.id,owner.id],'23514');
    await db.invalidCommit('UPDATE study_group_memberships SET role=\'ADMIN\' WHERE group_id=$1 AND user_id=$2',[group.id,member.id],'23514');
    await db.invalidCommit('UPDATE study_groups SET name=$2 WHERE id=$1',[group.id,' '],'23514');
    await db.invalidCommit('UPDATE study_groups SET name=$2 WHERE id=$1',[group.id,'x'.repeat(121)],'22001');
    await db.invalidCommit('UPDATE study_group_invitations SET revoked_at=clock_timestamp() WHERE group_id=$1',[group.id],'23514');
    await db.invalidCommit('UPDATE study_group_invitations SET token_digest=\'raw-token\' WHERE group_id=$1',[group.id],'23514');
    await db.invalidCommit('UPDATE study_group_invitations SET issuer_user_id=$2 WHERE group_id=$1',[group.id,other.id],'23503');
    const issued=await service.issueInvitation(owner.id,group.id);
    await db.invalidCommit('UPDATE study_group_invitations SET token_digest=(SELECT token_digest FROM study_group_invitations WHERE id=$2) WHERE id=$1',[issued.id,(await db.pool.query('SELECT id FROM study_group_invitations WHERE group_id=$1 AND id<>$2',[group.id,issued.id])).rows[0].id],'23505');
    await db.invalidCommit('INSERT INTO study_group_texts(group_id,author_user_id,body) VALUES($1,$2,\'Foreign author\')',[group.id,other.id],'23503');
    await ownerInvariant(group.id);
  });

  it('rejects revoked/expired/wrong-group tokens without consuming them', async () => {
    const {owner,other,group}=await fixture();
    const revoked=await service.issueInvitation(owner.id,group.id);
    await service.revokeInvitation(owner.id,group.id,revoked.id);
    await expect(service.acceptInvitation(other.id,{groupId:group.id,token:revoked.token})).rejects.toMatchObject({code:'GROUP_UNAVAILABLE'});
    const expired=await service.issueInvitation(owner.id,group.id);
    await db.pool.query('UPDATE study_group_invitations SET created_at=clock_timestamp()-interval \'2 days\',expires_at=clock_timestamp()-interval \'1 day\' WHERE id=$1',[expired.id]);
    await expect(service.acceptInvitation(other.id,{groupId:group.id,token:expired.token})).rejects.toMatchObject({code:'GROUP_UNAVAILABLE'});
    const valid=await service.issueInvitation(owner.id,group.id);
    await expect(service.acceptInvitation(other.id,{groupId:randomUUID(),token:valid.token})).rejects.toMatchObject({code:'GROUP_UNAVAILABLE'});
    expect((await db.pool.query('SELECT accepted_at FROM study_group_invitations WHERE id=ANY($1::uuid[])',[[revoked.id,expired.id,valid.id]])).rows.every(row=>row.accepted_at===null)).toBe(true);
  });

  it('uses fresh database clock after lock waits so an expired invitation remains unused', async () => {
    const {owner,other,group}=await fixture();
    const invite=await service.issueInvitation(owner.id,group.id);
    const blocker=await db.pool.connect();
    const contenderPool=new Pool({connectionString:db.scopedUrl,max:1,application_name:'phase22-expiry-wait'});
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM study_groups WHERE id=$1 FOR UPDATE',[group.id]);
      const result=new StudyGroupService(contenderPool).acceptInvitation(other.id,{groupId:group.id,token:invite.token}).then(()=>({ok:true,code:''}),(error: {code:string})=>({ok:false,code:error.code}));
      await waitForLock('phase22-expiry-wait');
      // Expire while the accept transaction is demonstrably waiting, without a wall-clock sleep.
      await blocker.query('UPDATE study_group_invitations SET created_at=clock_timestamp()-interval \'1 day\',expires_at=clock_timestamp() WHERE id=$1',[invite.id]);
      await blocker.query('COMMIT');
      expect(await result).toEqual({ok:false,code:'GROUP_UNAVAILABLE'});
      expect((await db.pool.query('SELECT accepted_at FROM study_group_invitations WHERE id=$1',[invite.id])).rows[0].accepted_at).toBeNull();
    } finally {await blocker.query('ROLLBACK');blocker.release();await contenderPool.end();}
  });

  it.each(['REVOKE_FIRST','ACCEPT_FIRST'] as const)('serializes invitation revoke versus accept: %s', async ordering => {
    const [owner,joiner]=await Promise.all([user(),user()]);
    const group=await service.createGroup(owner.id,{name:'Invite ordering'});
    const invite=await service.issueInvitation(owner.id,group.id);
    const blocker=await db.pool.connect();
    const applicationName='phase22-invite-'+ordering.toLowerCase();
    const contenderPool=new Pool({connectionString:db.scopedUrl,max:1,application_name:applicationName});
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM study_groups WHERE id=$1 FOR UPDATE',[group.id]);
      const contender=new StudyGroupService(contenderPool);
      const operation=ordering==='REVOKE_FIRST'
        ? contender.acceptInvitation(joiner.id,{groupId:group.id,token:invite.token})
        : contender.revokeInvitation(owner.id,group.id,invite.id);
      const outcome=operation.then(()=>({ok:true,code:''}),(error:{code:string})=>({ok:false,code:error.code}));
      await waitForLock(applicationName);
      if(ordering==='REVOKE_FIRST') {
        await blocker.query('UPDATE study_group_invitations SET revoked_at=clock_timestamp() WHERE id=$1',[invite.id]);
      } else {
        await blocker.query('INSERT INTO study_group_memberships(group_id,user_id,role) VALUES($1,$2,\'MEMBER\')',[group.id,joiner.id]);
        await blocker.query('UPDATE study_group_invitations SET accepted_at=clock_timestamp(),accepted_by_user_id=$2 WHERE id=$1',[invite.id,joiner.id]);
      }
      await blocker.query('COMMIT');
      expect(await outcome).toEqual({ok:false,code:'GROUP_UNAVAILABLE'});
      const stored=(await db.pool.query('SELECT accepted_at,revoked_at FROM study_group_invitations WHERE id=$1',[invite.id])).rows[0];
      const membership=(await db.pool.query('SELECT 1 FROM study_group_memberships WHERE group_id=$1 AND user_id=$2',[group.id,joiner.id])).rowCount;
      expect(membership).toBe(ordering==='REVOKE_FIRST'?0:1);
      expect(stored.accepted_at!==null).toBe(ordering==='ACCEPT_FIRST');
      expect(stored.revoked_at!==null).toBe(ordering==='REVOKE_FIRST');
    } finally {await blocker.query('ROLLBACK');blocker.release();await contenderPool.end();}
  });

  it('rechecks a moderator removal against a promoted target after a durable lock wait', async () => {
    const {owner,member,other,group}=await fixture();
    const invite=await service.issueInvitation(owner.id,group.id);
    await service.acceptInvitation(other.id,{groupId:group.id,token:invite.token});
    await service.setRole(owner.id,group.id,member.id,{role:'MODERATOR'});
    const blocker=await db.pool.connect();
    const contenderPool=new Pool({connectionString:db.scopedUrl,max:1,application_name:'phase22-role-wait'});
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM study_groups WHERE id=$1 FOR UPDATE',[group.id]);
      const result=new StudyGroupService(contenderPool).removeMember(member.id,group.id,other.id).then(()=>({ok:true,code:''}),(error: {code:string})=>({ok:false,code:error.code}));
      await waitForLock('phase22-role-wait');
      await blocker.query('UPDATE study_group_memberships SET role=\'MODERATOR\' WHERE group_id=$1 AND user_id=$2',[group.id,other.id]);
      await blocker.query('COMMIT');
      expect(await result).toEqual({ok:false,code:'GROUP_UNAVAILABLE'});
      expect((await service.listMembers(owner.id,group.id,{})).items.find(row=>row.userId===other.id)?.role).toBe('MODERATOR');
    } finally {await blocker.query('ROLLBACK');blocker.release();await contenderPool.end();}
  });

  it('rechecks a queued protected write after committed membership revocation', async () => {
    const {member,group}=await fixture();
    const blocker=await db.pool.connect();
    const contenderPool=new Pool({connectionString:db.scopedUrl,max:1,application_name:'phase22-revocation-wait'});
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[member.id]);
      await blocker.query('SELECT id FROM study_groups WHERE id=$1 FOR UPDATE',[group.id]);
      const result=new StudyGroupService(contenderPool).createText(member.id,group.id,{body:'Queued stale write'}).then(()=>({ok:true,code:''}),(error: {code:string})=>({ok:false,code:error.code}));
      await waitForLock('phase22-revocation-wait');
      await blocker.query('UPDATE study_group_memberships SET status=\'REMOVED\',role=\'MEMBER\' WHERE group_id=$1 AND user_id=$2',[group.id,member.id]);
      await blocker.query('COMMIT');
      expect(await result).toEqual({ok:false,code:'GROUP_UNAVAILABLE'});
      expect((await db.pool.query('SELECT 1 FROM study_group_texts WHERE group_id=$1',[group.id])).rowCount).toBe(0);
    } finally {await blocker.query('ROLLBACK');blocker.release();await contenderPool.end();}
  });

  it('serializes the final membership slot and rolls back invitation consumption on quota failure', async () => {
    const [owner,a,b]=await Promise.all([user(),user(),user()]);
    const group=await service.createGroup(owner.id,{name:'Bounded final slot'});
    for(let i=0;i<18;i++) {const member=await user();await db.pool.query('INSERT INTO study_group_memberships(group_id,user_id,role) VALUES($1,$2,\'MEMBER\')',[group.id,member.id]);}
    const invites=await Promise.all([service.issueInvitation(owner.id,group.id),service.issueInvitation(owner.id,group.id)]);
    const outcomes=await Promise.allSettled([a,b].map((actor,index)=>service.acceptInvitation(actor.id,{groupId:group.id,token:invites[index].token})));
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await db.pool.query('SELECT 1 FROM study_group_memberships WHERE group_id=$1 AND status=\'ACTIVE\'',[group.id])).rowCount).toBe(20);
    expect((await db.pool.query('SELECT 1 FROM study_group_invitations WHERE group_id=$1 AND accepted_at IS NOT NULL',[group.id])).rowCount).toBe(1);
  });

  it('serializes retained text capacity and preserves scoped report/history constraints', async () => {
    const {owner,member,other,group}=await fixture();
    for(let i=0;i<19;i++) await db.pool.query('INSERT INTO study_group_texts(group_id,author_user_id,body) VALUES($1,$2,$3)',[group.id,owner.id,'Text '+i]);
    const result=await Promise.allSettled([owner,member].map(actor=>service.createText(actor.id,group.id,{body:'Final text'})));
    expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await service.listTexts(member.id,group.id,{})).total).toBe(20);
    const text=(await service.listTexts(member.id,group.id,{})).items[0];
    await db.invalidCommit('INSERT INTO study_group_reports(group_id,text_id,reporter_user_id,reason) VALUES($1,$2,$3,\'Foreign reporter\')',[group.id,text.id,other.id],'23503');
    await service.reportText(member.id,group.id,text.id,{reason:'Scoped report'});
    await service.reportText(member.id,group.id,text.id,{reason:'Duplicate acknowledgment'});
    expect((await service.listReports(owner.id,group.id,{})).total).toBe(1);
    await service.removeMember(owner.id,group.id,member.id);
    expect((await service.listReports(owner.id,group.id,{})).total).toBe(1);
  });

  it('serializes a user final membership slot across distinct group locks', async () => {
    const [owner,joiner]=await Promise.all([user(),user()]);
    for(let i=0;i<19;i++) {
      const fixtureOwner=await user();
      const retained=await service.createGroup(fixtureOwner.id,{name:'Existing membership '+i});
      await db.pool.query('INSERT INTO study_group_memberships(group_id,user_id,role) VALUES($1,$2,\'MEMBER\')',[retained.id,joiner.id]);
    }
    const a=await service.createGroup(owner.id,{name:'User final slot A'});
    const b=await service.createGroup(owner.id,{name:'User final slot B'});
    const invitations=await Promise.all([service.issueInvitation(owner.id,a.id),service.issueInvitation(owner.id,b.id)]);
    const results=await Promise.allSettled([a,b].map((group,index)=>service.acceptInvitation(joiner.id,{groupId:group.id,token:invitations[index].token})));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await db.pool.query('SELECT 1 FROM study_group_memberships WHERE user_id=$1 AND status=\'ACTIVE\'',[joiner.id])).rowCount).toBe(20);
    expect((await db.pool.query('SELECT 1 FROM study_group_invitations WHERE id=ANY($1::uuid[]) AND accepted_at IS NOT NULL',[invitations.map(invite=>invite.id)])).rowCount).toBe(1);
  });

  it('rejects transfer to an actor already owning two retained groups without demoting the current owner', async () => {
    const {owner,member,group}=await fixture();
    await service.createGroup(member.id,{name:'Target owned A'});
    await service.createGroup(member.id,{name:'Target owned B'});
    await expect(service.transferOwnership(owner.id,group.id,{userId:member.id})).rejects.toMatchObject({code:'GROUP_LIMIT_REACHED'});
    await ownerInvariant(group.id);
    expect((await service.getGroup(owner.id,group.id)).role).toBe('OWNER');
    expect((await service.getGroup(member.id,group.id)).role).toBe('MEMBER');
  });

  it('hides uncommitted transfer intermediate states from another transaction and rolls back failed transfer', async () => {
    const {owner,member,group} = await fixture();
    const writer=await db.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('UPDATE study_group_memberships SET role=\'MEMBER\' WHERE group_id=$1 AND user_id=$2',[group.id,owner.id]);
      await ownerInvariant(group.id);
      await expect(writer.query('COMMIT')).rejects.toMatchObject({code:'23503'});
      await ownerInvariant(group.id);
      await writer.query('BEGIN');
      await writer.query('UPDATE study_group_memberships SET role=\'MEMBER\' WHERE group_id=$1 AND user_id=$2',[group.id,owner.id]);
      await writer.query('UPDATE study_group_memberships SET role=\'OWNER\' WHERE group_id=$1 AND user_id=$2',[group.id,member.id]);
      await ownerInvariant(group.id);
      await writer.query('UPDATE study_groups SET owner_user_id=$2 WHERE id=$1',[group.id,member.id]);
      await writer.query('COMMIT');
      await ownerInvariant(group.id);
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  });

  it('denies durably after removal, bans rejoin, and allows LEFT actors only by a new invite', async () => {
    const {owner,member,other,group} = await fixture();
    await service.removeMember(owner.id,group.id,member.id);
    await expect(service.getGroup(member.id,group.id)).rejects.toMatchObject({code:'GROUP_UNAVAILABLE'});
    const invite=await service.issueInvitation(owner.id,group.id);
    await expect(service.acceptInvitation(member.id,{groupId:group.id,token:invite.token})).rejects.toMatchObject({code:'GROUP_UNAVAILABLE'});
    await service.acceptInvitation(other.id,{groupId:group.id,token:invite.token});
    await service.leaveGroup(other.id,group.id);
    await expect(service.createText(other.id,group.id,{body:'Stale member'})).rejects.toMatchObject({code:'GROUP_UNAVAILABLE'});
    const next=await service.issueInvitation(owner.id,group.id);
    await service.acceptInvitation(other.id,{groupId:group.id,token:next.token});
    expect((await service.getGroup(other.id,group.id)).role).toBe('MEMBER');
  });

  it('counts failed accept attempts durably and caps concurrent rate counters', async () => {
    const actor=await user();
    const groupId=randomUUID();
    const results=await Promise.allSettled(Array.from({length:15},()=>service.acceptInvitation(actor.id,{groupId,token:'0'.repeat(43)})));
    expect(results.every(r=>r.status==='rejected')).toBe(true);
    const counter=await db.pool.query('SELECT hits FROM study_group_rate_limits WHERE user_id=$1 AND action=\'ACCEPT\'',[actor.id]);
    expect(counter.rows[0].hits).toBe(10);
    const rateFailures=results.filter(r=>r.status==='rejected' && (r.reason.code==='GROUP_RATE_LIMITED'||r.reason.getStatus?.()===429));
    expect(rateFailures).toHaveLength(5);
    await db.pool.query('UPDATE study_group_rate_limits SET reset_at=clock_timestamp()-interval \'1 second\' WHERE user_id=$1 AND action=\'ACCEPT\'',[actor.id]);
    await expect(service.acceptInvitation(actor.id,{groupId,token:'0'.repeat(43)})).rejects.toMatchObject({code:'GROUP_UNAVAILABLE'});
    const reset=await db.pool.query('SELECT hits,reset_at>clock_timestamp() AS current_window FROM study_group_rate_limits WHERE user_id=$1 AND action=\'ACCEPT\'',[actor.id]);
    expect(reset.rows[0]).toEqual({hits:1,current_window:true});
  });

  it('reverses only group migration and reapplies it without altering identity data', async () => {
    const actor=await user();
    await db.migration('0027_phase22_study_groups.down.sql');
    expect((await db.pool.query('SELECT id FROM users WHERE id=$1',[actor.id])).rowCount).toBe(1);
    expect((await db.pool.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename LIKE \'study_group%\'',[db.schema])).rowCount).toBe(0);
    await db.migration('0027_phase22_study_groups.sql');
    await service.createGroup(actor.id,{name:'After down/up'});
  });
});
