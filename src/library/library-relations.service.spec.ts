import { fixture } from './library-relations.test-fixtures';
describe('reviewed public related resources', () => {
  it('returns honest empty until explicit review and only canonical public payloads afterward', async () => {
    const f = await fixture();
    expect(await f.service.list(f.anchor.id, {})).toEqual({
      items: [],
      nextCursor: null,
    });
    await f.service.review(f.reviewer.id, {
      anchorId: f.anchor.id,
      targetId: f.target.id,
      type: 'SAME_CONCEPT',
      evidenceReference: 'review:synthetic:test',
    });
    const page = await f.service.list(f.anchor.id, {});
    expect(page.items).toEqual([
      {
        resource: await f.library.getPublicResource(f.target.id),
        relation: { type: 'SAME_CONCEPT' },
      },
    ]);
    expect(JSON.stringify(page)).not.toContain('evidenceReference');
  });
});
