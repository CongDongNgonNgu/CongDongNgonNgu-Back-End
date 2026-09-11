import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PROFILE_REPOSITORY, InMemoryProfileRepository } from '../src/profile/profile.repository';

describe('language explorer API', () => {
  let app: INestApplication;
  let profiles: InMemoryProfileRepository;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    profiles = app.get<InMemoryProfileRepository>(PROFILE_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists active languages and searches Unicode names through one public contract', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/languages')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toHaveLength(8);
        expect(body.data.map((language: { code: string }) => language.code)).toEqual([
          'vi', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es',
        ]);
      });

    for (const search of ['Tiếng Nhật', 'Français', '中文', '한국어', 'English']) {
      await request(app.getHttpServer())
        .get('/api/v1/languages')
        .query({ search })
        .expect(200)
        .expect(({ body }) => expect(body.data).toHaveLength(1));
    }
  });

  it('resolves every launch language and a later catalog addition without route branches', async () => {
    for (const slug of [
      'vietnamese',
      'english',
      'chinese',
      'japanese',
      'korean',
      'french',
      'german',
      'spanish',
    ]) {
      await request(app.getHttpServer())
        .get('/api/v1/languages/' + slug)
        .expect(200)
        .expect(({ body }) => expect(body.data.slug).toBe(slug));
    }

    await profiles.seed([{
      code: 'pt',
      slug: 'portuguese',
      nativeName: 'Português',
      englishName: 'Portuguese',
      vietnameseName: 'Tiếng Bồ Đào Nha',
      direction: 'ltr',
      active: true,
      launch: false,
      sortOrder: 90,
    }]);

    await request(app.getHttpServer())
      .get('/api/v1/languages/portuguese')
      .expect(200)
      .expect(({ body }) => expect(body.data.code).toBe('pt'));
  });

  it('returns deterministic errors for unknown, inactive, and malformed slugs', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/languages/unknown')
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('LANGUAGE_NOT_FOUND'));

    await profiles.setActive('fr', false);
    await request(app.getHttpServer())
      .get('/api/v1/languages/french')
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('LANGUAGE_INACTIVE'));
    await profiles.setActive('fr', true);

    await request(app.getHttpServer())
      .get('/api/v1/languages/%25')
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('LANGUAGE_INVALID_SLUG'));
  });

  it('returns a truthful overview with non-working future sections', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/languages/english/overview')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.language.slug).toBe('english');
        expect(body.data.metrics.learnerCount).toEqual({
          state: 'NOT_AVAILABLE_YET',
          value: null,
        });
        expect(body.data.sections).toHaveLength(10);
        expect(body.data.sections
          .filter((section: { key: string }) => section.key !== 'overview')
          .every((section: {
            status: string;
            isNavigable: boolean;
            href: string | null;
          }) => (
            section.status === 'NOT_IMPLEMENTED' &&
            section.isNavigable === false &&
            section.href === null
          ))).toBe(true);
      });
  });

  it('normalizes repeated overview filters without inventing resource results', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/languages/english/overview')
      .query({ level: ['B2', 'A1', 'A1'], topic: '  Travel  ' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.filters.levels).toEqual(['A1', 'B2']);
        expect(body.data.filters.topic).toBe('travel');
        expect(body.data.metrics.resourceCount).toEqual({
          state: 'NOT_AVAILABLE_YET',
          value: null,
        });
      });

    await request(app.getHttpServer())
      .get('/api/v1/languages/english/overview')
      .query({ topic: '   ' })
      .expect(200)
      .expect(({ body }) => expect(body.data.filters.topic).toBeNull());
  });

  it('returns stable validation errors for invalid overview filters', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/languages/english/overview')
      .query({ level: 'A7' })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('LANGUAGE_INVALID_LEVEL'));

    await request(app.getHttpServer())
      .get('/api/v1/languages/english/overview')
      .query({ topic: 'travel!' })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('LANGUAGE_INVALID_TOPIC'));

    await request(app.getHttpServer())
      .get('/api/v1/languages/english/overview')
      .query({ topic: 'space-opera' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.filters.topic).toBe('space-opera');
        expect(body.data.filters.topicState).toBe('NOT_AVAILABLE_YET');
      });
  });
});
