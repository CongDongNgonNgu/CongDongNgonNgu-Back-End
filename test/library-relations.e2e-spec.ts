import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { LIBRARY_REPOSITORY } from '../src/library/library.repository';
import { LIBRARY_RELATIONS_REPOSITORY } from '../src/library/library-relations.repository';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import { PROFILE_REPOSITORY } from '../src/profile/profile.repository';
import { fixture } from '../src/library/library-relations.test-fixtures';

describe('related Library public HTTP contract', () => {
  let app: INestApplication;
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture();
    await f.service.review(f.reviewer.id, {
      anchorId: f.anchor.id,
      targetId: f.target.id,
      type: 'SAME_CONCEPT',
      evidenceReference: 'review:http:synthetic',
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LIBRARY_REPOSITORY)
      .useValue(f.repository)
      .overrideProvider(LIBRARY_RELATIONS_REPOSITORY)
      .useValue(f.relations)
      .overrideProvider(IDENTITY_REPOSITORY)
      .useValue(f.identity)
      .overrideProvider(PROFILE_REPOSITORY)
      .useValue(f.profiles)
      .compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  it('returns canonical source/license payload with only accepted public relation type', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/library/resources/' + f.anchor.id + '/related')
      .expect(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].relation).toEqual({ type: 'SAME_CONCEPT' });
    expect(
      res.body.data.items[0].resource.provenance[0].license
        .redistributionAllowed,
    ).toBe(true);
    expect(res.body.data.nextCursor).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(
      /reviewerUserId|evidenceReference|revision|Snapshot/,
    );
  });
  it('accepts the established case-insensitive UUIDv4 route', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/v1/library/resources/' + f.anchor.id.toUpperCase() + '/related',
      )
      .expect(200);
  });
  it.each([
    'relation=SIMILAR',
    'type=ALL',
    'language=xx',
    'level=C3',
    'limit=13',
    'limit=0',
    'limit=1.5',
    'cursor=bad',
    'recursive=true',
    'q=private',
    'relationType=SAME_CONCEPT',
  ])('rejects invalid/unknown query %s', async (query) => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/library/resources/' + f.anchor.id + '/related?' + query)
      .expect(400);
    expect(res.body.data).toBeUndefined();
  });
  it('matches the canonical public detail404 envelope', async () => {
    const id = '00000000-0000-4000-8000-000000000099';
    const detail = await request(app.getHttpServer())
      .get('/api/v1/library/resources/' + id)
      .expect(404);
    const related = await request(app.getHttpServer())
      .get('/api/v1/library/resources/' + id + '/related')
      .expect(404);
    expect(related.body.error).toEqual(detail.body.error);
  });

  it('uses generic404 for unknown or private anchor and forbids assertion routes', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/v1/library/resources/00000000-0000-4000-8000-000000000099/related',
      )
      .expect(404);
    const resource = await f.resource('private-http');
    await f.repository.setModerationState(resource.id, 'HIDDEN', new Date());
    await request(app.getHttpServer())
      .get('/api/v1/library/resources/' + resource.id + '/related')
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/library/resources/' + f.anchor.id + '/related')
      .send({ targetId: f.target.id })
      .expect(404);
  });
});
