import { fixture } from './library-relations.test-fixtures';
import type { LibraryResourceRecord } from './library.types';
import { LIBRARY_RELATION_TYPES } from './library-relations.types';

const review = (
  f: Awaited<ReturnType<typeof fixture>>,
  targetId = f.target.id,
  type: (typeof LIBRARY_RELATION_TYPES)[number] = 'SAME_CONCEPT',
) =>
  f.service.review(f.reviewer.id, {
    anchorId: f.anchor.id,
    targetId,
    type,
    evidenceReference: 'review:synthetic:test',
  });
function mutate(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  action: (r: LibraryResourceRecord) => void,
) {
  const resources = (
    f.repository as unknown as { resources: Map<string, LibraryResourceRecord> }
  ).resources;
  action(resources.get(id)!);
}
describe('related eligibility and pagination bounds', () => {
  it.each([
    { limit: 0 },
    { limit: 13 },
    { limit: 1.2 },
    { limit: '' },
    { limit: [] },
    { relation: 'INFERRED' },
    { type: 'ALL' },
    { level: 'C3' },
    { language: 'xx' },
    { cursor: 'broken' },
    { cursor: 'x'.repeat(513) },
    { q: 'protected text' },
  ])('rejects invalid query %j', async (input) => {
    const f = await fixture();
    await expect(f.service.list(f.anchor.id, input)).rejects.toMatchObject({
      status: 400,
    });
  });
  it('denies spoofed reviewer, disabled or downgraded authority', async () => {
    const f = await fixture();
    await expect(
      f.service.review(f.target.id, {
        anchorId: f.anchor.id,
        targetId: f.target.id,
        type: 'SAME_CONCEPT',
        evidenceReference: 'test',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await review(f);
    await f.identity.replaceUserRoles(f.reviewer.id, ['USER']);
    expect((await f.service.list(f.anchor.id, {})).items).toEqual([]);
    await f.identity.replaceUserRoles(f.reviewer.id, ['ADMIN']);
    await f.identity.updateUser(f.reviewer.id, { status: 'DISABLED' });
    expect((await f.service.list(f.anchor.id, {})).items).toEqual([]);
  });
  it.each([
    'visibility',
    'moderationState',
    'reviewState',
    'provenance',
    'details',
    'primaryLanguageCode',
    'cefrLevel',
    'topics',
    'updatedAt',
    'provenanceRevision',
  ] as const)(
    'suppresses changed target %s without stale fields',
    async (key) => {
      const f = await fixture();
      await review(f);
      mutate(f, f.target.id, (r) => {
        switch (key) {
          case 'visibility':
            r.visibility = 'PRIVATE';
            break;
          case 'moderationState':
            r.moderationState = 'HIDDEN';
            break;
          case 'reviewState':
            r.reviewState = 'DRAFT';
            break;
          case 'provenance':
            r.provenance[0].attribution = 'changed source';
            break;
          case 'details':
            if (r.details.resourceType === 'VOCABULARY')
              r.details.term = 'changed';
            break;
          case 'primaryLanguageCode':
            r.primaryLanguageCode = 'vi';
            break;
          case 'cefrLevel':
            r.cefrLevel = 'B2';
            break;
          case 'topics':
            r.topics = ['changed'];
            break;
          case 'updatedAt':
            r.updatedAt = new Date(r.updatedAt.getTime() + 1000);
            break;
          case 'provenanceRevision':
            r.provenanceRevision++;
        }
      });
      expect((await f.service.list(f.anchor.id, {})).items).toEqual([]);
    },
  );
  it('requires explicit re-review after source mutation and revocation', async () => {
    const f = await fixture();
    const first = await review(f);
    mutate(f, f.target.id, (r) => {
      r.provenance[0].sourceUrl = 'https://example.test/new-source';
    });
    expect((await f.service.list(f.anchor.id, {})).items).toEqual([]);
    const second = await review(f);
    expect(second.revision).toBe(first.revision + 1);
    expect((await f.service.list(f.anchor.id, {})).items).toHaveLength(1);
    await f.service.revoke(f.reviewer.id, {
      anchorId: f.anchor.id,
      targetId: f.target.id,
      type: 'SAME_CONCEPT',
    });
    expect((await f.service.list(f.anchor.id, {})).items).toEqual([]);
    expect((await review(f)).revision).toBe(second.revision + 2);
  });
  it.each(['inactive', 'unknown', 'unsafe', 'renamed'])(
    'suppresses current %s license',
    async (kind) => {
      const f = await fixture();
      await review(f);
      const licenses = (
        f.repository as unknown as {
          licenses: Map<
            string,
            {
              active: boolean;
              redistributionAllowed: boolean | null;
              displayName: string;
            }
          >;
        }
      ).licenses;
      if (kind === 'unknown') licenses.delete('TEST-V1');
      else if (kind === 'inactive') licenses.get('TEST-V1')!.active = false;
      else if (kind === 'unsafe')
        licenses.get('TEST-V1')!.redistributionAllowed = null;
      else licenses.get('TEST-V1')!.displayName = 'Changed license';
      // Anchor license is also affected: generic public detail 404.
      if (kind === 'renamed')
        expect((await f.service.list(f.anchor.id, {})).items).toEqual([]);
      else
        await expect(f.service.list(f.anchor.id, {})).rejects.toMatchObject({
          status: 404,
        });
    },
  );
  it('deduplicates deterministic accepted types and never expands cycles', async () => {
    const f = await fixture();
    await review(f, f.target.id, 'FOLLOW_UP');
    await review(f);
    await f.service.review(f.reviewer.id, {
      anchorId: f.target.id,
      targetId: f.anchor.id,
      type: 'FOLLOW_UP',
      evidenceReference: 'reverse reviewed',
    });
    const page = await f.service.list(f.anchor.id, {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0].relation.type).toBe('SAME_CONCEPT');
    expect(
      (await f.service.list(f.anchor.id, { relation: 'FOLLOW_UP' })).items[0]
        .relation.type,
    ).toBe('FOLLOW_UP');
    expect(
      (await f.service.list(f.anchor.id, { language: 'vi' })).items,
    ).toEqual([]);
    expect(
      (await f.service.list(f.anchor.id, { type: 'SENTENCE' })).items,
    ).toEqual([]);
    expect((await f.service.list(f.anchor.id, { level: 'B2' })).items).toEqual(
      [],
    );
  });
  it('paginates opaque query-bound UUID keysets without repeats and enforces limit', async () => {
    const f = await fixture();
    const ids = [f.target.id];
    await review(f);
    for (let i = 0; i < 5; i++) {
      const r = await f.resource('page' + i);
      ids.push(r.id);
      await review(f, r.id);
    }
    const first = await f.service.list(f.anchor.id, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const decoded = Buffer.from(first.nextCursor!, 'base64url').toString(
      'utf8',
    );
    for (const id of ids) expect(decoded).not.toContain(id);
    for (const input of [
      { limit: 3 },
      { limit: 2, level: 'A1' },
      { limit: 2, language: 'en' },
    ])
      await expect(
        f.service.list(f.anchor.id, { ...input, cursor: first.nextCursor }),
      ).rejects.toMatchObject({ status: 400 });
    const seen = first.items.map((i) => i.resource.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await f.service.list(f.anchor.id, { limit: 2, cursor });
      seen.push(...page.items.map((i) => i.resource.id));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(ids.sort());
    expect(new Set(seen).size).toBe(6);
  });
  it('scans at most64 targets and advances even through entirely ineligible pages', async () => {
    const f = await fixture();
    for (let i = 0; i < 66; i++) {
      const r = await f.resource('scan' + i);
      await review(f, r.id);
      mutate(f, r.id, (r) => {
        r.visibility = 'PRIVATE';
      });
    }
    const scan = jest.spyOn(f.repository, 'findResourcesByIds');
    const first = await f.service.list(f.anchor.id, {});
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    expect(scan.mock.calls.every(([ids]) => ids.length <= 64)).toBe(true);
    const second = await f.service.list(f.anchor.id, {
      cursor: first.nextCursor!,
    });
    expect(second).toEqual({ items: [], nextCursor: null });
  });
  it('rechecks target and assertion changes during final projection', async () => {
    const f = await fixture();
    await review(f);
    const original = f.repository.findResourcesByIds.bind(f.repository);
    let reads = 0;
    jest
      .spyOn(f.repository, 'findResourcesByIds')
      .mockImplementation(async (ids) => {
        reads++;
        if (reads === 3)
          mutate(f, f.target.id, (r) => {
            r.details = {
              resourceType: 'VOCABULARY',
              term: 'secret changed',
              definition: 'changed',
              partOfSpeech: null,
              exampleSentence: null,
            };
          });
        return original(ids);
      });
    expect((await f.service.list(f.anchor.id, {})).items).toEqual([]);
  });
  it('rejects self links and collection assertions without a collection anchor', async () => {
    const f = await fixture();
    await expect(review(f, f.anchor.id)).rejects.toMatchObject({ status: 400 });
    await expect(
      review(f, f.target.id, 'COLLECTION_MEMBER'),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// No partial provenance projection:32 is accepted,33 is a related-only omission.
describe('related provenance capacity', () => {
  it('enforces exact32/33 bounds before memory hydration while canonical detail remains available', async () => {
    const f = await fixture();
    const target = (
      f.repository as unknown as {
        resources: Map<string, LibraryResourceRecord>;
      }
    ).resources.get(f.target.id)!;
    const base = target.provenance[0];
    target.provenance = Array.from({ length: 32 }, (_, i) => ({
      ...base,
      id: 'synthetic-source-' + i,
      sourceId: 'synthetic-source-' + i,
    }));
    await review(f);
    expect((await f.service.list(f.anchor.id, {})).items).toHaveLength(1);
    target.provenance.push({ ...base, id: 'source33', sourceId: 'source33' });
    expect(await f.repository.findResourcesByIds([f.target.id])).toEqual([]);
    expect((await f.service.list(f.anchor.id, {})).items).toEqual([]);
    expect(
      (await f.library.getPublicResource(f.target.id))?.provenance,
    ).toHaveLength(33);
  });
});
