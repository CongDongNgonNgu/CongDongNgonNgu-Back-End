import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SessionService } from '../src/auth/session/session.service';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';
import { MemoryConnectionOutbox } from '../src/exchange/memory-connection-outbox';
import { ConnectionNotificationWorker } from '../src/exchange/connection-notification-worker';
import { NOTIFICATION_REPOSITORY,type NotificationRepository } from '../src/notifications/notification.repository';

describe('Phase26 authenticated connection notification integration',()=>{
  let app:INestApplication;let clock=Date.now();let automatic:jest.SpyInstance;
  const actors:{id:string;token:string}[]=[];
  beforeAll(async()=>{
    automatic=jest.spyOn(ConnectionNotificationWorker.prototype,'onModuleInit').mockImplementation(()=>undefined);
    const module=await Test.createTestingModule({imports:[AppModule]})
      .overrideProvider(MemoryConnectionOutbox).useValue(new MemoryConnectionOutbox(()=>clock)).compile();
    app=module.createNestApplication();configureApp(app);await app.init();
    const identity=app.get<IdentityRepository>(IDENTITY_REPOSITORY);
    for(const name of ['Requesting actor','Accepting actor','Unrelated actor']) {
      const user=await identity.createUser({email:name.replaceAll(' ','-')+'@phase26.invalid',displayName:name,
        passwordHash:null,status:'ACTIVE',emailVerifiedAt:new Date()});
      const response={append:()=>undefined} as unknown as Response;
      const token=(await app.get(SessionService).issue(user,response)).accessToken;actors.push({id:user.id,token});
      await request(app.getHttpServer()).patch('/api/v1/profile').set('Authorization','Bearer '+token)
        .send({languages:[{languageCode:'en',roles:['known','learning'],declaredProficiency:'B1',
          isPrimaryLearningTarget:true,visibility:'PUBLIC'}]}).expect(200);
      await request(app.getHttpServer()).patch('/api/v1/exchange/preferences').set('Authorization','Bearer '+token)
        .send({exchangeOptIn:true,discoverable:true,offeredLanguageCodes:['en'],wantedLanguageCodes:['en']}).expect(200);
    }
  });
  afterAll(async()=>{await app?.close();automatic?.mockRestore();});

  it('keeps successful HTTP mutations independent of delivery failure and exposes only currently authorized notices',async()=>{
    const [a,b,c]=actors;const server=app.getHttpServer();const worker=app.get(ConnectionNotificationWorker);
    const repository=app.get<NotificationRepository>(NOTIFICATION_REPOSITORY);const original=repository.claimIntent.bind(repository);
    const claim=jest.spyOn(repository,'claimIntent').mockRejectedValueOnce(new Error('Synthetic notification persistence failure')).mockImplementation(original);
    await request(server).post(`/api/v1/exchange/relationships/${b.id}/request`).set('Authorization','Bearer '+a.token).expect(200)
      .expect(({body})=>expect(body.data.state).toBe('OUTGOING_PENDING'));
    const outbox=app.get(MemoryConnectionOutbox);const enqueue=jest.spyOn(outbox,'enqueue');
    for(const action of ['accept','decline','cancel','disconnect']) {
      await request(server).post(`/api/v1/exchange/relationships/${b.id}/${action}`)
        .set('Authorization','Bearer '+c.token).expect(409);
    }
    await request(server).post(`/api/v1/exchange/relationships/${b.id}/decline`).set('Authorization','Bearer '+a.token).expect(409);
    await request(server).post(`/api/v1/exchange/relationships/${a.id}/cancel`).set('Authorization','Bearer '+b.token).expect(409);
    expect(enqueue).not.toHaveBeenCalled();enqueue.mockRestore();
    expect(claim).not.toHaveBeenCalled();expect(await worker.runOnce()).toEqual({processed:0,failed:1});
    await request(server).get(`/api/v1/exchange/relationships/${b.id}`).set('Authorization','Bearer '+a.token).expect(200)
      .expect(({body})=>expect(body.data.state).toBe('OUTGOING_PENDING'));
    clock+=5000;expect(await worker.runOnce()).toEqual({processed:1,failed:0});
    await request(server).get('/api/v1/notifications').set('Authorization','Bearer '+b.token).expect(200)
      .expect(({body})=>{expect(body.data.unreadCount).toBe(1);expect(body.data.items[0]).toMatchObject({notificationType:'BUDDY_REQUEST',
        actor:{kind:'USER',displayName:'Requesting actor'},target:{path:'/exchange/connections'},variables:{}});});
    await request(server).post(`/api/v1/exchange/relationships/${a.id}/accept`).set('Authorization','Bearer '+b.token).expect(200)
      .expect(({body})=>expect(body.data.state).toBe('CONNECTED'));
    expect(await worker.runOnce()).toEqual({processed:1,failed:0});
    await request(server).get('/api/v1/notifications').set('Authorization','Bearer '+a.token).expect(200)
      .expect(({body})=>{expect(body.data.unreadCount).toBe(1);expect(body.data.items[0]).toMatchObject({notificationType:'BUDDY_CONNECTED',actor:{displayName:'Accepting actor'}});});
    await request(server).post(`/api/v1/exchange/blocks/${b.id}`).set('Authorization','Bearer '+a.token).expect(200);
    for(const actor of [a,b]) {
      await request(server).get('/api/v1/notifications').set('Authorization','Bearer '+actor.token).expect(200)
        .expect(({body})=>{expect(body.data.unreadCount).toBe(0);expect(body.data.items[0]).toMatchObject({actor:{kind:'DELETED'},target:null,variables:{}});});
      await request(server).get('/api/v1/notifications/unread-count').set('Authorization','Bearer '+actor.token).expect(200)
        .expect(({body})=>expect(body.data.unreadCount).toBe(0));
    }
    await request(server).get('/api/v1/notifications').set('Authorization','Bearer '+c.token).expect(200)
      .expect(({body})=>expect(body.data).toMatchObject({items:[],unreadCount:0}));
    claim.mockRestore();
  });
});
