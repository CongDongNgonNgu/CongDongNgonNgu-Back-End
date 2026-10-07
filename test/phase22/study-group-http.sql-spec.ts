import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { AuthModule } from '../../src/auth/auth.module';
import { SessionService } from '../../src/auth/session/session.service';
import { configureApp } from '../../src/app.setup';
import { buildConfiguration } from '../../src/config/configuration';
import { validateEnvironment } from '../../src/config/env.validation';
import { IDENTITY_REPOSITORY } from '../../src/identity/identity.module';
import { PostgresIdentityRepository } from '../../src/identity/postgres-identity.repository';
import { StudyGroupModule } from '../../src/study-groups/study-group.module';
import { StudyGroupService } from '../../src/study-groups/study-group.service';
import { SqlHarness } from './sql-harness';

describe('Phase22 real PostgreSQL HTTP authorization', () => {
  const db = new SqlHarness();
  let app: INestApplication;
  let identity: PostgresIdentityRepository;
  let sessions: SessionService;
  let groups: StudyGroupService;
  const prefix='/api/v1/study-groups';
  beforeAll(async () => {
    await db.open();
    identity=new PostgresIdentityRepository(db.pool);
    groups=new StudyGroupService(db.pool);
    const config=buildConfiguration(validateEnvironment({
      NODE_ENV:'test',PORT:'3000',PUBLIC_APP_URL:'http://localhost:5173',CORS_ALLOWED_ORIGINS:'http://localhost:5173',DATABASE_URL:db.scopedUrl,
      AUTH_PERSISTENCE:'postgres',JWT_ACCESS_SECRET:'phase22-isolated-access-secret-at-least-32',JWT_REFRESH_SECRET:'phase22-isolated-refresh-secret-at-least-32',
      PAYMENT_PROVIDER:'disabled',PAYMENT_QR_ENABLED:'false',EMAIL_PROVIDER:'disabled',STORAGE_PROVIDER:'disabled',REALTIME_PROVIDER:'disabled',AI_PROVIDER:'disabled',OAUTH_PROVIDER:'disabled',SESSION_STORE:'disabled',
    }));
    const moduleRef=await Test.createTestingModule({imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true,load:[()=>config]}),AuthModule,StudyGroupModule]})
      .overrideProvider(IDENTITY_REPOSITORY).useValue(identity).overrideProvider(StudyGroupService).useValue(groups).compile();
    app=moduleRef.createNestApplication(); configureApp(app); await app.init(); sessions=app.get(SessionService);
  });
  afterAll(async () => { await app?.close(); await db.close(); });
  beforeEach(async () => { await db.reset(); });
  async function actor(role?: 'ADMIN'|'MODERATOR') {
    const user=await identity.createUser({email:randomUUID()+'@phase22.invalid',displayName:'HTTP synthetic actor',passwordHash:null,status:'ACTIVE'});
    if(role) await db.pool.query('INSERT INTO user_roles(user_id,role_key) VALUES($1,$2)',[user.id,role]);
    const fresh=await identity.findUserById(user.id);
    const cookies:string[]=[];
    const credentials=await sessions.issue(fresh!,{append:(_key:string,value:string)=>cookies.push(value)} as unknown as Response);
    return {...user,token:credentials.accessToken,cookies};
  }
  async function fixture() {
    const [owner,member,mod,stranger,admin,platformMod]=await Promise.all([actor(),actor(),actor(),actor(),actor('ADMIN'),actor('MODERATOR')]);
    const group=await groups.createGroup(owner.id,{name:'Private bounded group'});
    for(const user of [member,mod]) {const invite=await groups.issueInvitation(owner.id,group.id); await groups.acceptInvitation(user.id,{groupId:group.id,token:invite.token});}
    await groups.setRole(owner.id,group.id,mod.id,{role:'MODERATOR'});
    return {owner,member,mod,stranger,admin,platformMod,group};
  }
  const http=()=>request(app.getHttpServer());
  const bearer=(user:{token:string})=>({Authorization:'Bearer '+user.token});

  it('creates persisted owner membership and returns bounded safe no-store projections', async () => {
    const owner=await actor();
    const result=await http().post(prefix).set(bearer(owner)).send({name:'Vietnamese / English',description:'Plain text'}).expect(201);
    expect(result.body.data.role).toBe('OWNER');
    expect(result.headers['cache-control']).toContain('no-store');
    const groupId=result.body.data.id;
    expect((await db.pool.query('SELECT role,status FROM study_group_memberships WHERE group_id=$1 AND user_id=$2',[groupId,owner.id])).rows[0]).toEqual({role:'OWNER',status:'ACTIVE'});
    const list=await http().get(prefix+'?limit=1').set(bearer(owner)).expect(200);
    expect(list.body.data).toMatchObject({page:1,limit:1,total:1});
    expect(Object.keys(list.body.data.items[0]).sort()).toEqual(['createdAt','description','id','name','role','status','updatedAt'].sort());
    await http().post(prefix).set(bearer(owner)).send({name:'Tamper',ownerUserId:owner.id}).expect(400);
    await http().get(prefix+'?limit=21').set(bearer(owner)).expect(400);
  });

  it('uses uniform unavailable errors for every foreign protected path and denies platform overrides', async () => {
    const {owner,member,mod,stranger,admin,platformMod,group}=await fixture();
    await groups.createGroup(stranger.id,{name:'Independent group A'});
    const text=await groups.createText(member.id,group.id,{body:'Secret text'});
    await groups.reportText(member.id,group.id,text.id,{reason:'Synthetic scoped report'});
    const reports=await groups.listReports(owner.id,group.id,{});
    const invite=await groups.issueInvitation(owner.id,group.id);
    const cases:[string,string,Record<string,string>?][]=[
      ['get','/'+group.id],['get','/'+group.id+'/members'],['get','/'+group.id+'/invitations'],['post','/'+group.id+'/invitations',{}],
      ['delete','/'+group.id+'/invitations/'+invite.id],['post','/'+group.id+'/leave',{}],['delete','/'+group.id+'/members/'+member.id],
      ['patch','/'+group.id+'/members/'+member.id+'/role',{role:'MODERATOR'}],['post','/'+group.id+'/ownership',{userId:member.id}],['post','/'+group.id+'/archive',{}],
      ['get','/'+group.id+'/texts'],['post','/'+group.id+'/texts',{body:'Attack'}],['post','/'+group.id+'/texts/'+text.id+'/hide',{}],
      ['post','/'+group.id+'/texts/'+text.id+'/reports',{reason:'Attack'}],['get','/'+group.id+'/reports'],['post','/'+group.id+'/reports/'+reports.items[0].id+'/resolve',{}],
    ];
    for(const outsider of [stranger,admin,platformMod]) for(const [method,route,body] of cases) {
      const result=await (http() as unknown as Record<string,(url:string)=>request.Test>)[method](prefix+route).set(bearer(outsider)).send(body).expect(404);
      expect(result.body.error.code).toBe('GROUP_UNAVAILABLE');
      expect(JSON.stringify(result.body)).not.toContain('Secret text');
    }
    await http().get(prefix+'/'+group.id).expect(401);
    for(const user of [member,mod]) await http().post(prefix+'/'+group.id+'/invitations').set(bearer(user)).send({}).expect(404);
    await http().post(prefix+'/'+group.id+'/ownership').set(bearer(mod)).send({userId:mod.id}).expect(404);
    await http().delete(prefix+'/'+group.id+'/members/'+owner.id).set(bearer(mod)).expect(404);
    await http().delete(prefix+'/'+group.id+'/members/'+mod.id).set(bearer(mod)).expect(404);
    await http().patch(prefix+'/'+group.id+'/members/'+member.id+'/role').set(bearer(member)).send({role:'MODERATOR'}).expect(404);
    await http().patch(prefix+'/'+group.id+'/members/'+member.id+'/role').set(bearer(owner)).send({role:'MODERATOR'}).expect(200);
    await http().delete(prefix+'/'+group.id+'/members/'+member.id).set(bearer(mod)).expect(404);
    expect((await http().get(prefix).set(bearer(admin)).expect(200)).body.data.total).toBe(0);
    const ownList=(await http().get(prefix).set(bearer(stranger)).expect(200)).body.data;
    expect(ownList.total).toBe(1);
    expect(ownList.items.some((item:{id:string})=>item.id===group.id)).toBe(false);
  });

  it('rejects substituted invitation/text/report IDs across groups and hides privileged totals', async () => {
    const {owner,member,group}=await fixture();
    const foreignOwner=await actor();
    const foreign=await groups.createGroup(foreignOwner.id,{name:'Foreign'});
    const invitation=await groups.issueInvitation(foreignOwner.id,foreign.id);
    const text=await groups.createText(foreignOwner.id,foreign.id,{body:'Foreign secret'});
    await groups.reportText(foreignOwner.id,foreign.id,text.id,{reason:'Foreign report'});
    const report=(await groups.listReports(foreignOwner.id,foreign.id,{})).items[0];
    await http().delete(prefix+'/'+group.id+'/invitations/'+invitation.id).set(bearer(owner)).expect(404);
    await http().post(prefix+'/invitations/accept').set(bearer(member)).send({groupId:group.id,token:invitation.token}).expect(404);
    await http().post(prefix+'/'+group.id+'/texts/'+text.id+'/hide').set(bearer(owner)).send({}).expect(404);
    await http().post(prefix+'/'+group.id+'/texts/'+text.id+'/reports').set(bearer(member)).send({reason:'Foreign'}).expect(404);
    await http().post(prefix+'/'+group.id+'/reports/'+report.id+'/resolve').set(bearer(owner)).send({}).expect(404);
    const local=await groups.createText(member.id,group.id,{body:'Hidden local'});
    await groups.hideText(owner.id,group.id,local.id);
    const page=await http().get(prefix+'/'+group.id+'/texts').set(bearer(member)).expect(200);
    expect(page.body.data).toMatchObject({items:[],total:0});
    expect((await http().get(prefix+'/'+group.id+'/texts').set(bearer(owner)).expect(200)).body.data.total).toBe(1);
  });

  it('revokes stale bearer authorization immediately after leave/remove and freshly denies disabled accounts', async () => {
    const {owner,member,mod,group}=await fixture();
    await http().get(prefix+'/'+group.id).set(bearer(member)).expect(200);
    await http().delete(prefix+'/'+group.id+'/members/'+member.id).set(bearer(mod)).expect(200);
    await http().get(prefix+'/'+group.id).set(bearer(member)).expect(404);
    expect((await http().get(prefix).set(bearer(member)).expect(200)).body.data.total).toBe(0);
    await http().post(prefix+'/'+group.id+'/leave').set(bearer(mod)).send({}).expect(200);
    await http().get(prefix+'/'+group.id+'/members').set(bearer(mod)).expect(404);
    await identity.updateUser(owner.id,{status:'DISABLED'});
    await http().get(prefix+'/'+group.id).set(bearer(owner)).expect(401);
  });

  it('preserves real cookie CSRF/origin enforcement on mutating group actions', async () => {
    const owner=await actor();
    const cookie=owner.cookies.map(value=>value.split(';')[0]).join('; ');
    await http().post(prefix).set(bearer(owner)).set('Cookie',cookie).send({name:'Unsafe cookie'}).expect(403);
    const csrf=owner.cookies.find(value=>value.startsWith('cdn_csrf='))?.split(';')[0].split('=')[1];
    expect(csrf).toBeDefined();
    await http().post(prefix).set(bearer(owner)).set('Cookie',cookie).set('Origin','https://foreign.invalid').set('X-CSRF-Token',csrf!).send({name:'Bad origin'}).expect(403);
    await http().post(prefix).set(bearer(owner)).set('Cookie',cookie).set('Origin','http://localhost:5173').set('X-CSRF-Token',csrf!).send({name:'Good cookie'}).expect(201);
  });

  it('completes real HTTP invitation, text/report duty, transfer and archive lifecycle', async () => {
    const [owner,member,outsider]=await Promise.all([actor(),actor(),actor()]);
    const group=(await http().post(prefix).set(bearer(owner)).send({name:'Lifecycle'}).expect(201)).body.data;
    const invite=(await http().post(prefix+'/'+group.id+'/invitations').set(bearer(owner)).send({}).expect(200)).body.data;
    expect(typeof invite.token==='string' && invite.token.length===43).toBe(true);
    const invitationList=(await http().get(prefix+'/'+group.id+'/invitations').set(bearer(owner)).expect(200)).body.data;
    expect(Object.keys(invitationList.items[0]).sort()).toEqual(['createdAt','expiresAt','id','state'].sort());
    await http().post(prefix+'/invitations/accept').set(bearer(member)).send({groupId:group.id,token:invite.token}).expect(200);
    await http().post(prefix+'/invitations/accept').set(bearer(outsider)).send({groupId:group.id,token:invite.token}).expect(404);
    const text=(await http().post(prefix+'/'+group.id+'/texts').set(bearer(member)).send({body:'Study text'}).expect(201)).body.data;
    expect(Object.keys(text).sort()).toEqual(['author','body','createdAt','hidden','id'].sort());
    await http().post(prefix+'/'+group.id+'/texts/'+text.id+'/reports').set(bearer(member)).send({reason:'Synthetic reason'}).expect(200);
    const reports=(await http().get(prefix+'/'+group.id+'/reports').set(bearer(owner)).expect(200)).body.data;
    expect(Object.keys(reports.items[0]).sort()).toEqual(['createdAt','id','reason','status','textId'].sort());
    await http().post(prefix+'/'+group.id+'/reports/'+reports.items[0].id+'/resolve').set(bearer(owner)).send({}).expect(200);
    await http().post(prefix+'/'+group.id+'/ownership').set(bearer(owner)).send({userId:outsider.id}).expect(404);
    await http().post(prefix+'/'+group.id+'/ownership').set(bearer(owner)).send({userId:owner.id}).expect(404);
    await http().post(prefix+'/'+group.id+'/ownership').set(bearer(owner)).send({userId:member.id}).expect(200);
    expect((await http().get(prefix+'/'+group.id).set(bearer(owner)).expect(200)).body.data.role).toBe('MEMBER');
    expect((await http().get(prefix+'/'+group.id).set(bearer(member)).expect(200)).body.data.role).toBe('OWNER');
    await http().post(prefix+'/'+group.id+'/invitations').set(bearer(owner)).send({}).expect(404);
    await http().post(prefix+'/'+group.id+'/archive').set(bearer(member)).send({}).expect(200);
    await http().get(prefix+'/'+group.id).set(bearer(member)).expect(404);
    await http().get(prefix+'/'+group.id+'/texts').set(bearer(owner)).expect(404);
    expect((await db.pool.query('SELECT status FROM study_groups WHERE id=$1',[group.id])).rows[0].status).toBe('ARCHIVED');
    expect((await db.pool.query('SELECT 1 FROM study_group_texts WHERE group_id=$1',[group.id])).rowCount).toBe(1);
  });
});
