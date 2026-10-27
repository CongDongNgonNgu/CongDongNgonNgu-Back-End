import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { gzipSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

describe('request parsing dependency compatibility', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => { await app?.close(); });

  // Use native HTTP so Supertest cannot JSON-serialize the compressed Buffer.
  function postCompressed(body: Buffer): Promise<number> {
    const { port } = app.getHttpServer().address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/v1/auth/register', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': body.length } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', reject);
      });
      req.setTimeout(5000, () => req.destroy(new Error('Compressed request timed out')));
      req.on('error', reject);
      req.end(body);
    });
  }

  it('parses URL-encoded registration through the real validation and auth services', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .type('form')
      .send({ email: 'form-parser@example.com', displayName: 'Form Parser', password: 'Correct horse battery staple 2026' })
      .expect(201)
      .expect(({ body }) => expect(body.data).toEqual({ verificationRequired: true }));
  });

  it('parses compressed JSON through the real validation and auth services', async () => {
    const body = gzipSync(JSON.stringify({ email: 'gzip-parser@example.com', displayName: 'Gzip Parser', password: 'Correct horse battery staple 2026' }));
    expect(await postCompressed(body)).toBe(201);
  });

  it('rejects malformed JSON and continues serving requests', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/register')
      .set('Content-Type', 'application/json').send('{"email":').expect(400);
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });

  it('rejects trailing garbage after compressed JSON and keeps the server alive', async () => {
    const payload = Buffer.concat([gzipSync('{}'), Buffer.from('trailing garbage')]);
    expect(await postCompressed(payload)).toBe(400);
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });

  it('rejects unsupported encodings without exposing parser internals', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/register')
      .set('Content-Type', 'application/json').set('Content-Encoding', 'unknown')
      .send('{}').expect(415)
      .expect(({ body }) => expect(body).toEqual({ success: false, error: {
        code: 'HTTP_415', message: 'Unsupported request encoding',
      } }));
  });

  it('rejects a body exceeding the default JSON limit before auth processing', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/register')
      .send({ padding: 'x'.repeat(110 * 1024) }).expect(413);
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });
});
