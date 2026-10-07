import { writeFileSync } from 'node:fs';
import { createExperiment, fixture, fingerprint, fixtureBytes, type Query } from './retrieval.fixture';

function score(ids: string[], expected: string[]) {
  const hits = ids.filter(id => expected.includes(id)).length;
  const first = ids.findIndex(id => expected.includes(id));
  return { returned: ids.length, relevantReturned: hits, labeled: expected.length,
    precisionAt3: hits / 3, recallAt3: expected.length ? hits / expected.length : null,
    reciprocalRank: expected.length ? (first < 0 ? 0 : 1 / (first + 1)) : null };
}

describe('Phase21 frozen contextual discovery benchmark', () => {
  it('computes denominators correctly without inventing relevance on empty queries', () => {
    expect(score(['irrelevant', 'right'], ['right', 'other'])).toEqual({ returned: 2,
      relevantReturned: 1, labeled: 2, precisionAt3: 1 / 3, recallAt3: 1 / 2, reciprocalRank: 1 / 2 });
    expect(score([], []).recallAt3).toBeNull();
    expect(score(['irrelevant'], []).relevantReturned).toBe(0);
  });

  it('runs every frozen query on identical eligible pools and records actual outputs', async () => {
    const digest = fingerprint(fixtureBytes.replace(/\r\n/g, '\n'));
    expect(digest).toBe('030edc9377c84f44e175fc45c9fc91d53756d5377178163f55823e4f5b7c57f7');
    const experiment = await createExperiment();
    const eligibleBefore = [];
    for (const resource of fixture.resources) {
      const publicResource = await experiment.service.getPublicResource(experiment.id(resource.key));
      expect(publicResource).not.toBeNull();
      eligibleBefore.push(publicResource);
    }
    const poolVersion = fingerprint(eligibleBefore);
    const rows: Array<{ query: Query; expected: string[];
      lexical: { ids: string[]; score: ReturnType<typeof score> };
      candidate: { ids: string[]; mode: string; score: ReturnType<typeof score>; sourceCards: unknown[] } }> = [];
    let provenanceViolations = 0;
    for (const query of fixture.queries) {
      const expected = query.expected.map(experiment.id);
      const baseline = await experiment.baseline(query);
      const candidate = await experiment.retrieve(query);
      for (const item of candidate.items) {
        const canonical = await experiment.service.getPublicResource(item.resource.id);
        if (!canonical || fingerprint(item.resource) !== fingerprint(canonical)) provenanceViolations++;
      }
      rows.push({ query, expected, lexical: { ids: baseline.items.map(x => x.id),
        score: score(baseline.items.map(x => x.id), expected) },
      candidate: { ids: candidate.items.map(x => x.resource.id), mode: candidate.mode,
        score: score(candidate.items.map(x => x.resource.id), expected),
        sourceCards: candidate.items.map(x => ({ resourceId: x.resource.id, provenance: x.resource.provenance,
          relation: x.relation })) } });
    }
    const eligibleAfter = [];
    for (const resource of fixture.resources) eligibleAfter.push(await experiment.service.getPublicResource(experiment.id(resource.key)));
    expect(fingerprint(eligibleAfter)).toBe(poolVersion);
    const positive = rows.filter(x => x.expected.length);
    const empty = rows.filter(x => !x.expected.length);
    const controls = rows.filter(x => x.query.control);
    function aggregate(approach: 'lexical' | 'candidate') {
      const returned = rows.reduce((n, row) => n + row[approach].score.returned, 0);
      const hits = rows.reduce((n, row) => n + row[approach].score.relevantReturned, 0);
      const recallSum = positive.reduce((n, row) => n + row[approach].score.recallAt3!, 0);
      const reciprocalRankSum = positive.reduce((n, row) => n + row[approach].score.reciprocalRank!, 0);
      return { queryCount: rows.length, positiveQueryCount: positive.length, labeledTotal: positive.reduce((n, x) => n + x.expected.length, 0),
        returned, relevantReturned: hits, precisionSlots: positive.length * 3,
        precisionAt3: hits / (positive.length * 3), returnedPrecision: returned ? hits / returned : 0,
        recallSum, macroRecall: recallSum / positive.length, reciprocalRankSum,
        mrr: reciprocalRankSum / positive.length,
        emptyQueryCount: empty.length, correctEmptyQueries: empty.filter(x => !x[approach].ids.length).length,
        abstentions: rows.filter(x => !x[approach].ids.length).map(x => x.query.id) };
    }
    const lexical = aggregate('lexical');
    const candidate = aggregate('candidate');
    const controlRegressions = controls.filter(x => x.candidate.score.relevantReturned < x.lexical.score.relevantReturned).length;
    const recallGain = candidate.macroRecall - lexical.macroRecall;
    const thresholds = fixture.thresholds;
    const qualityThresholdMet = candidate.macroRecall >= thresholds.candidateMacroRecallMinimum
      && recallGain >= thresholds.macroRecallGainMinimum && candidate.returnedPrecision >= thresholds.returnedPrecisionMinimum
      && controlRegressions <= thresholds.controlRegressionsMaximum
      && candidate.correctEmptyQueries === thresholds.correctEmptyQueriesRequired;
    const report = { version: fixture.version, fixtureSha256: digest, poolVersion, poolCount: eligibleBefore.length,
      baselineSha: 'd56fc2c518a617018d6926bf63b482572268a1ef', configuration: fixture.configuration,
      thresholds, lexical, candidate, recallGain, controlCount: controls.length, controlRegressions,
      canonicalProvenanceComparisons: candidate.returned, provenanceViolations, qualityThresholdMet, rows };
    // Optional local evidence export; CI does not need a sibling Workspace checkout.
    const output = process.env.PHASE21_EVIDENCE_OUTPUT;
    if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('PHASE21_METRICS=' + JSON.stringify({ lexical, candidate, recallGain, controlRegressions,
      provenanceViolations, qualityThresholdMet }));
    expect(provenanceViolations).toBe(0);
    expect(rows).toHaveLength(14);
    // The benchmark may truthfully fail quality and close REJECT/DEFER; do not tune it to force GO.
  });
});
