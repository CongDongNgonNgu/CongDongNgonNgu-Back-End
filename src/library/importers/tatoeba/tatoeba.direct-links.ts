import { compareSentenceIds, directTranslationIdentity, inputPairIdentity, translationProvenanceSourceId } from './tatoeba.identities';
import type {
  TatoebaConfiguredDirection,
  TatoebaLinkRow,
  TatoebaProvenancePreview,
  TatoebaQuarantineEntry,
  TatoebaTranslationCandidate,
  TatoebaValidatedSentenceCandidate,
} from './tatoeba.types';

export interface TatoebaDirectLinkBuildCounts {
  reciprocalPairsCollapsed: number;
  missingLinkEndpoints: number;
  sameLanguageLinks: number;
  ambiguousLanguageLinks: number;
  duplicateInputPairs: number;
  translationCandidates: number;
  directionConflicts: number;
}

export interface TatoebaDirectLinkBuildInput {
  links: readonly TatoebaLinkRow[];
  eligibleSentences: ReadonlyMap<string, TatoebaValidatedSentenceCandidate>;
  directions: readonly TatoebaConfiguredDirection[];
}

export interface TatoebaDirectLinkBuildResult {
  candidates: TatoebaTranslationCandidate[];
  quarantine: TatoebaQuarantineEntry[];
  counts: TatoebaDirectLinkBuildCounts;
}

function provenancePreview(
  source: TatoebaValidatedSentenceCandidate,
  sourceId: string,
  targetId: string,
  role: 'SOURCE' | 'TARGET',
  pairIdentity: string,
  primaryLanguageCode: TatoebaConfiguredDirection['sourceLanguage'],
  secondaryLanguageCode: TatoebaConfiguredDirection['targetLanguage'],
): TatoebaProvenancePreview {
  const relationIdentity = directTranslationIdentity(sourceId, targetId);
  return {
    sourceId: translationProvenanceSourceId(sourceId, targetId, role),
    sourceUrl: source.sourceUrl,
    license: source.license,
    owner: source.owner,
    attribution: source.attribution,
    endpointSentenceId: source.sentenceId,
    endpointRole: role,
    relationIdentity,
    inputPairIdentity: pairIdentity,
    primaryLanguageCode,
    secondaryLanguageCode,
    importBatch: source.importBatch,
    snapshotId: source.snapshotId,
    apiCheckedAt: source.apiCheckedAt,
    transformationNote: null,
  };
}

export function buildTatoebaTranslationCandidates(
  input: TatoebaDirectLinkBuildInput,
): TatoebaDirectLinkBuildResult {
  const counts: TatoebaDirectLinkBuildCounts = {
    reciprocalPairsCollapsed: 0,
    missingLinkEndpoints: 0,
    sameLanguageLinks: 0,
    ambiguousLanguageLinks: 0,
    duplicateInputPairs: 0,
    translationCandidates: 0,
    directionConflicts: 0,
  };
  const quarantine: TatoebaQuarantineEntry[] = [];
  const pairs = new Map<string, { leftId: string; rightId: string }>();

  for (const link of input.links) {
    const pairId = inputPairIdentity(link.sentenceId, link.translationId);
    const existing = pairs.get(pairId);
    if (existing) {
      counts.reciprocalPairsCollapsed += 1;
      if (existing.leftId === link.sentenceId && existing.rightId === link.translationId) counts.duplicateInputPairs += 1;
      continue;
    }
    pairs.set(pairId, { leftId: link.sentenceId, rightId: link.translationId });
  }

  const orderedPairs = [...pairs.entries()].sort((left, right) => {
    const leftComparison = compareSentenceIds(left[1].leftId, right[1].leftId);
    return leftComparison !== 0 ? leftComparison : compareSentenceIds(left[1].rightId, right[1].rightId);
  });
  const durableIdentities = new Set<string>();
  const candidates: TatoebaTranslationCandidate[] = [];

  for (const [pairId, pair] of orderedPairs) {
    const left = input.eligibleSentences.get(pair.leftId);
    const right = input.eligibleSentences.get(pair.rightId);
    if (!left || !right) {
      counts.missingLinkEndpoints += 1;
      quarantine.push({
        kind: 'LINK',
        sourceId: pair.leftId,
        relatedSourceId: pair.rightId,
        reason: 'TATOEBA_LINK_ENDPOINT_NOT_ELIGIBLE',
        details: {},
      });
      continue;
    }
    if (left.projectLanguage === right.projectLanguage) {
      counts.sameLanguageLinks += 1;
      continue;
    }

    const directedEndpoints: Array<{
      source: TatoebaValidatedSentenceCandidate;
      target: TatoebaValidatedSentenceCandidate;
      primaryLanguageCode: TatoebaConfiguredDirection['sourceLanguage'];
      secondaryLanguageCode: TatoebaConfiguredDirection['targetLanguage'];
    }> = [];
    for (const direction of input.directions) {
      if (left.projectLanguage === direction.sourceLanguage && right.projectLanguage === direction.targetLanguage) {
        directedEndpoints.push({
          source: left,
          target: right,
          primaryLanguageCode: direction.sourceLanguage,
          secondaryLanguageCode: direction.targetLanguage,
        });
      }
      if (right.projectLanguage === direction.sourceLanguage && left.projectLanguage === direction.targetLanguage) {
        directedEndpoints.push({
          source: right,
          target: left,
          primaryLanguageCode: direction.sourceLanguage,
          secondaryLanguageCode: direction.targetLanguage,
        });
      }
    }
    if (directedEndpoints.length === 0) {
      counts.ambiguousLanguageLinks += 1;
      quarantine.push({
        kind: 'LINK',
        sourceId: pair.leftId,
        relatedSourceId: pair.rightId,
        reason: 'TATOEBA_DIRECTION_NOT_CONFIGURED',
        details: { leftLanguage: left.projectLanguage, rightLanguage: right.projectLanguage },
      });
      continue;
    }

    for (const endpoint of directedEndpoints) {
      const durableIdentity = directTranslationIdentity(endpoint.source.sentenceId, endpoint.target.sentenceId);
      if (durableIdentities.has(durableIdentity)) {
        counts.directionConflicts += 1;
        quarantine.push({
          kind: 'LINK',
          sourceId: endpoint.source.sentenceId,
          relatedSourceId: endpoint.target.sentenceId,
          reason: 'TATOEBA_DIRECTION_IDENTITY_CONFLICT',
          details: { durableIdentity },
        });
        continue;
      }
      durableIdentities.add(durableIdentity);
      candidates.push({
        provider: 'TATOEBA',
        inputPairIdentity: pairId,
        durableIdentity,
        primaryLanguageCode: endpoint.primaryLanguageCode,
        secondaryLanguageCode: endpoint.secondaryLanguageCode,
        sourceSentenceId: endpoint.source.sentenceId,
        targetSentenceId: endpoint.target.sentenceId,
        sourceText: endpoint.source.text,
        translatedText: endpoint.target.text,
        sourceProvenance: provenancePreview(
          endpoint.source,
          endpoint.source.sentenceId,
          endpoint.target.sentenceId,
          'SOURCE',
          pairId,
          endpoint.primaryLanguageCode,
          endpoint.secondaryLanguageCode,
        ),
        targetProvenance: provenancePreview(
          endpoint.target,
          endpoint.source.sentenceId,
          endpoint.target.sentenceId,
          'TARGET',
          pairId,
          endpoint.primaryLanguageCode,
          endpoint.secondaryLanguageCode,
        ),
      });
    }
  }

  candidates.sort((left, right) => {
    const sourceComparison = compareSentenceIds(left.sourceSentenceId, right.sourceSentenceId);
    return sourceComparison !== 0 ? sourceComparison : compareSentenceIds(left.targetSentenceId, right.targetSentenceId);
  });
  counts.translationCandidates = candidates.length;
  return { candidates, quarantine, counts };
}
