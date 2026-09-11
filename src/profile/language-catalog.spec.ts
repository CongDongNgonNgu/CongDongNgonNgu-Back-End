import { describe, expect, it } from '@jest/globals';
import {
  INITIAL_LANGUAGE_CATALOG,
  InMemoryLanguageCatalogRepository,
} from './language-catalog';

describe('InMemoryLanguageCatalogRepository', () => {
  it('seeds the eight launch languages idempotently', async () => {
    const repository = new InMemoryLanguageCatalogRepository();

    expect(await repository.listActive()).toHaveLength(8);
    await repository.seed(INITIAL_LANGUAGE_CATALOG);
    await repository.seed(INITIAL_LANGUAGE_CATALOG);

    const languages = await repository.listActive();
    expect(languages).toHaveLength(8);
    expect(languages.map((language) => language.code)).toEqual([
      'vi',
      'en',
      'zh',
      'ja',
      'ko',
      'fr',
      'de',
      'es',
    ]);
  });

  it('rejects duplicate codes and slugs in a seed payload', async () => {
    const repository = new InMemoryLanguageCatalogRepository();

    await expect(repository.seed([
      INITIAL_LANGUAGE_CATALOG[0],
      { ...INITIAL_LANGUAGE_CATALOG[1], code: INITIAL_LANGUAGE_CATALOG[0].code },
    ])).rejects.toMatchObject({ name: 'ProfileRepositoryConflictError' });

    await expect(repository.seed([
      INITIAL_LANGUAGE_CATALOG[0],
      { ...INITIAL_LANGUAGE_CATALOG[1], slug: INITIAL_LANGUAGE_CATALOG[0].slug },
    ])).rejects.toMatchObject({ name: 'ProfileRepositoryConflictError' });
  });

  it('does not return inactive or unknown languages from active lookup', async () => {
    const repository = new InMemoryLanguageCatalogRepository();
    await repository.setActive('fr', false);

    expect(await repository.findActiveByCodes(['fr', 'unknown'])).toEqual([]);
    expect(await repository.findByCodes(['fr', 'unknown'])).toHaveLength(1);
  });

  it('resolves canonical slugs without hiding inactive catalog records', async () => {
    const repository = new InMemoryLanguageCatalogRepository();
    await repository.setActive('fr', false);

    expect(await repository.findBySlug('french')).toMatchObject({
      code: 'fr',
      slug: 'french',
      active: false,
    });
    expect(await repository.findBySlug('unknown')).toBeNull();
  });

  it('matches Unicode catalog fields and keeps wildcard characters literal', async () => {
    const repository = new InMemoryLanguageCatalogRepository();

    expect((await repository.listActive('Tiếng Nhật')).map((language) => language.code)).toEqual(['ja']);
    expect((await repository.listActive('Français')).map((language) => language.code)).toEqual(['fr']);
    expect((await repository.listActive('日本語')).map((language) => language.code)).toEqual(['ja']);
    expect((await repository.listActive('%')).map((language) => language.code)).toEqual([]);
  });
});
