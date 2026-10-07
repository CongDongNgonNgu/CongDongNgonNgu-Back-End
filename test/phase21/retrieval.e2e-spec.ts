import { createExperiment, fixture, fingerprint, type Edge } from './retrieval.fixture';

describe('Phase21 isolated retrieval safety', () => {
  it('preserves canonical provenance and an explainable direct relation', async () => {
    const experiment = await createExperiment();
    const query = fixture.queries[0];
    const result = await experiment.retrieve(query);
    expect(result.mode).toBe('RELATIONAL');
    expect(result.items.map(x => x.resource.id)).toEqual([experiment.id('welcome')]);
    expect(result.items[0].relation).toMatchObject({ id: 'e01', type: 'SAME_CONCEPT' });
    expect(result.items[0].resource).toEqual(await experiment.service.getPublicResource(experiment.id('welcome')));
    expect(result.items[0].resource.provenance[0].sourceId).toBe('phase21:welcome');
    expect(JSON.stringify(result)).not.toContain('createdByUserId');
  });

  it.each(['PRIVATE', 'INACTIVE', 'UNVERIFIED', 'DELETED', 'PROVENANCE_MISSING', 'LICENSE_MISSING', 'LICENSE_INACTIVE', 'LICENSE_UNSAFE', 'SOURCE_INVALID', 'SOURCE_CHANGED'])(
    'suppresses %s targets at both retrieval and response boundaries', async state => {
      const experiment = await createExperiment();
      const query = { ...fixture.queries[0], q: 'unlisted safety query' };
      const prepared = await experiment.prepare(query);
      expect(prepared.references).toHaveLength(1);
      await experiment.invalidate('welcome', state);
      expect((await experiment.serialize(prepared)).items).toEqual([]);
      expect((await experiment.retrieve(query)).items).toEqual([]);
      if (state !== 'SOURCE_CHANGED') {
        expect(await experiment.service.getPublicResource(experiment.id('welcome'))).toBeNull();
        const list = await experiment.service.searchPublicResources({ q: 'nice to meet' });
        expect(list.items).toEqual([]);
      }
    },
  );

  it.each(['REMOVED', 'REASON_CHANGED', 'TARGET_SUBSTITUTED', 'TYPE_CHANGED'])(
    'invalidates stale prepared relation after %s', async state => {
      const experiment = await createExperiment();
      const prepared = await experiment.prepare(fixture.queries[0]);
      const edge = experiment.edges.find(x => x.id === 'e01')!;
      if (state === 'REMOVED') experiment.edges.splice(experiment.edges.indexOf(edge), 1);
      if (state === 'REASON_CHANGED') edge.reason = 'Replaced unreviewed claim';
      if (state === 'TARGET_SUBSTITUTED') edge.to = experiment.id('river');
      if (state === 'TYPE_CHANGED') edge.type = 'FOLLOW_UP';
      expect((await experiment.serialize(prepared)).items).toEqual([]);
    },
  );

  it.each(['PRIVATE', 'DELETED', 'SOURCE_CHANGED'])(
    'inaccessible/changed %s anchor cannot authorize targets or fallback', async state => {
      const experiment = await createExperiment();
      const prepared = await experiment.prepare(fixture.queries[0]);
      await experiment.invalidate('hello', state);
      expect((await experiment.serialize(prepared)).items).toEqual([]);
      if (state !== 'SOURCE_CHANGED') expect((await experiment.retrieve(fixture.queries[0])).items).toEqual([]);
    },
  );

  it.each(['UNKNOWN', 'MALFORMED', 'UNSUPPORTED', 'SUBSTITUTED', 'SELF'])(
    'rejects %s edge without disclosing target metadata', async state => {
      const experiment = await createExperiment();
      const edge = experiment.edges.find(x => x.id === 'e01')!;
      experiment.edges = [edge];
      if (state === 'UNKNOWN') edge.to = '00000000-0000-4000-8000-000000000099';
      if (state === 'MALFORMED') edge.reason = '';
      if (state === 'UNSUPPORTED') edge.type = 'AI_SIMILARITY';
      if (state === 'SUBSTITUTED') edge.to = experiment.id('river');
      if (state === 'SELF') edge.to = edge.from;
      const result = await experiment.retrieve({ ...fixture.queries[0], q: 'unlisted safety query' });
      expect(result.items).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('watercourse');
    },
  );

  it('deduplicates targets and does not traverse cycles', async () => {
    const experiment = await createExperiment();
    const edge = experiment.edges.find(x => x.id === 'e01')!;
    experiment.edges.push({ ...edge, id: 'e11' });
    const reverse = { ...edge, id: 'e12', from: edge.to, to: edge.from,
      fromVersion: edge.toVersion, toVersion: edge.fromVersion };
    experiment.edges.push(reverse);
    expect((await experiment.retrieve(fixture.queries[0])).items.map(x => x.resource.id))
      .toEqual([experiment.id('welcome')]);
  });

  it.each([null, undefined, 1, {}, { id: 5 }])('rejects raw malformed edge %p before sorting', async malformed => {
    const experiment = await createExperiment();
    experiment.edges = [malformed as unknown as Edge, experiment.edges[0]];
    const result = await experiment.retrieve(fixture.queries[0]);
    expect(result.items.map(x => x.resource.id)).toEqual([experiment.id('welcome')]);
  });

  it('filters targets across languages, types and levels', async () => {
    const experiment = await createExperiment();
    for (const query of fixture.queries.slice(0, 9)) {
      const result = await experiment.retrieve(query);
      expect(result.items.map(x => x.resource.id).sort()).toEqual(query.expected.map(experiment.id).sort());
    }
    expect((await experiment.retrieve({ ...fixture.queries[0], language: 'vi', type: 'VOCABULARY' })).items).toEqual([]);
  });

  it('retains lexical source cards and safe abstention without supported edges', async () => {
    const experiment = await createExperiment();
    for (const query of fixture.queries.slice(9)) {
      const result = await experiment.retrieve(query);
      expect(result.mode).toBe('LEXICAL_FALLBACK');
      expect(result.items.map(x => x.resource.id).sort()).toEqual(query.expected.map(experiment.id).sort());
      expect(result.items.every(x => x.relation === null)).toBe(true);
    }
  });

  it('rejects oversized traversal input and preserves frozen fixture bytes', async () => {
    const experiment = await createExperiment();
    experiment.edges = Array.from({ length: 65 }, () => experiment.edges[0]);
    expect((await experiment.retrieve(fixture.queries[0])).items).toEqual([]);
    expect(fingerprint(experiment.fixtureBytes.replace(/\r\n/g, '\n')))
      .toBe('030edc9377c84f44e175fc45c9fc91d53756d5377178163f55823e4f5b7c57f7');
  });
});
