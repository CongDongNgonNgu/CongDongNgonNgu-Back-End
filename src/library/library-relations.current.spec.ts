import { ConfigService } from '@nestjs/config';
import { LibraryRelationsService } from './library-relations.service';
import { fixture } from './library-relations.test-fixtures';
import type { LibraryResourceRecord } from './library.types';
const read = async (f: Awaited<ReturnType<typeof fixture>>) =>
  f.repository.findResourceById(f.target.id);
function records(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    f.repository as unknown as { resources: Map<string, LibraryResourceRecord> }
  ).resources;
}
const review = (
  f: Awaited<ReturnType<typeof fixture>>,
  type: 'SAME_CONCEPT' | 'DIRECT_TRANSLATION' = 'SAME_CONCEPT',
) =>
  f.service.review(f.reviewer.id, {
    anchorId: f.anchor.id,
    targetId: f.target.id,
    type,
    evidenceReference: 'review:synthetic:more',
  });
describe('related current source and final checks', () => {
  it('supports explicit direct translation from vocabulary only when source text/languages match', async () => {
    const f = await fixture();
    const target = records(f).get(f.target.id)!;
    target.resourceType = 'TRANSLATION';
    target.details = {
      resourceType: 'TRANSLATION',
      sourceText: 'anchor',
      translatedText: 'neo',
    };
    target.secondaryLanguageCode = 'vi';
    await review(f, 'DIRECT_TRANSLATION');
    expect((await f.service.list(f.anchor.id, {})).items[0].relation.type).toBe(
      'DIRECT_TRANSLATION',
    );
    target.details.sourceText = 'different';
    await expect(review(f, 'DIRECT_TRANSLATION')).rejects.toMatchObject({
      status: 409,
    });
    target.details.sourceText = 'anchor';
    target.primaryLanguageCode = 'vi';
    await expect(review(f, 'DIRECT_TRANSLATION')).rejects.toMatchObject({
      status: 409,
    });
    target.primaryLanguageCode = 'en';
    target.secondaryLanguageCode = 'en';
    await expect(review(f, 'DIRECT_TRANSLATION')).rejects.toMatchObject({
      status: 409,
    });
  });
  it.each(['no-provenance', 'deleted', 'source-mismatch', 'unhealthy'])(
    'suppresses %s without protected target metadata',
    async (kind) => {
      const health = { valid: true };
      const f = await fixture(health);
      const target = records(f).get(f.target.id)!;
      if (kind === 'source-mismatch' || kind === 'unhealthy') {
        const p = target.provenance[0];
        p.sourceType = 'PHASE06_LIBRARY_CANDIDATE';
        p.sourceId = p.sourceCandidateId =
          '00000000-0000-4000-8000-000000000001';
        p.sourcePostId = '00000000-0000-4000-8000-000000000002';
        p.sourceResponseId = '00000000-0000-4000-8000-000000000003';
        p.sourceAcceptanceId = '00000000-0000-4000-8000-000000000004';
      }
      await review(f);
      if (kind === 'no-provenance') target.provenance = [];
      else if (kind === 'deleted') records(f).delete(f.target.id);
      else if (kind === 'source-mismatch')
        target.provenance[0].sourceAcceptanceId = null;
      else health.valid = false;
      expect((await f.service.list(f.anchor.id, {})).items).toEqual([]);
    },
  );
  it.each(['revoke', 'revision', 'reviewer'])(
    'suppresses final %s race using current reads',
    async (kind) => {
      const f = await fixture();
      await review(f);
      const original = f.repository.findResourcesByIds.bind(f.repository);
      let reads = 0;
      jest
        .spyOn(f.repository, 'findResourcesByIds')
        .mockImplementation(async (ids) => {
          if (++reads === 3) {
            if (kind === 'revoke')
              await f.service.revoke(f.reviewer.id, {
                anchorId: f.anchor.id,
                targetId: f.target.id,
                type: 'SAME_CONCEPT',
              });
            else if (kind === 'revision') await review(f);
            else await f.identity.replaceUserRoles(f.reviewer.id, ['USER']);
          }
          return original(ids);
        });
      expect((await f.service.list(f.anchor.id, {})).items).toEqual([]);
    },
  );
  it('rejects tampered/wrong-anchor/rotated cursors without exposing identity', async () => {
    const f = await fixture();
    await review(f);
    const target = await f.resource('cursor-other');
    await f.service.review(f.reviewer.id, {
      anchorId: f.anchor.id,
      targetId: target.id,
      type: 'SAME_CONCEPT',
      evidenceReference: 'test',
    });
    const page = await f.service.list(f.anchor.id, { limit: 1 });
    const token = page.nextCursor!;
    const bytes = Buffer.from(token, 'base64url');
    bytes[30] ^= 1;
    await expect(
      f.service.list(f.anchor.id, {
        limit: 1,
        cursor: bytes.toString('base64url'),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.service.list(f.target.id, { limit: 1, cursor: token }),
    ).rejects.toMatchObject({ status: 400 });
    const rotated = new LibraryRelationsService(
      f.library,
      f.repository,
      f.relations,
      f.identity,
      f.profiles,
      new ConfigService({ auth: { accessSecret: 'synthetic-rotated-key' } }),
    );
    await expect(
      rotated.list(f.anchor.id, { limit: 1, cursor: token }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('returns visible result after a64target all-hidden page', async () => {
    const f = await fixture();
    const targets: LibraryResourceRecord[] = [];
    for (let i = 0; i < 65; i++) {
      const r = await f.resource('visible-last-' + i);
      targets.push(r);
      await f.service.review(f.reviewer.id, {
        anchorId: f.anchor.id,
        targetId: r.id,
        type: 'SAME_CONCEPT',
        evidenceReference: 'synthetic',
      });
    }
    targets.sort((a, b) => a.id.localeCompare(b.id));
    for (const r of targets.slice(0, 64))
      records(f).get(r.id)!.visibility = 'PRIVATE';
    const first = await f.service.list(f.anchor.id, {});
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const second = await f.service.list(f.anchor.id, {
      cursor: first.nextCursor!,
    });
    expect(second.items[0].resource.id).toBe(targets[64].id);
    expect(second.nextCursor).toBeNull();
  });
});
