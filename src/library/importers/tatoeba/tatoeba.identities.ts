import { createHash } from 'node:crypto';

import { TATOEBA_MAX_ID_DIGITS } from './tatoeba.constants';
import { tatoebaError } from './tatoeba.errors';

export function canonicalSentenceId(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > TATOEBA_MAX_ID_DIGITS) {
    throw tatoebaError('TATOEBA_INVALID_ID', 'Tatoeba sentence IDs must be positive decimal strings.');
  }
  return value;
}

export function compareSentenceIds(left: string, right: string): number {
  const a = canonicalSentenceId(left);
  const b = canonicalSentenceId(right);
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sentenceSourceIdentity(sentenceId: string): string {
  return `TATOEBA:SENTENCE:${canonicalSentenceId(sentenceId)}`;
}

export function inputPairIdentity(leftId: string, rightId: string): string {
  const left = canonicalSentenceId(leftId);
  const right = canonicalSentenceId(rightId);
  const [minId, maxId] = compareSentenceIds(left, right) <= 0 ? [left, right] : [right, left];
  return `TATOEBA:PAIR:${minId}:${maxId}`;
}

export function directTranslationIdentity(sourceId: string, targetId: string): string {
  return `TATOEBA:LINK:DIRECT:${canonicalSentenceId(sourceId)}:${canonicalSentenceId(targetId)}`;
}

export function translationLockIdentity(sourceId: string, targetId: string): string {
  return `OPEN_DATASET:${directTranslationIdentity(sourceId, targetId)}`;
}

export function translationProvenanceSourceId(
  sourceId: string,
  targetId: string,
  role: 'SOURCE' | 'TARGET',
): string {
  return `${directTranslationIdentity(sourceId, targetId)}:${role}`;
}

export function deterministicSnapshotId(artifacts: readonly { kind: string; fileName: string; sizeBytes: number; sha256: string }[]): string {
  const material = [...artifacts]
    .sort((left, right) => left.kind.localeCompare(right.kind))
    .map((artifact) => `${artifact.kind}\t${artifact.fileName}\t${artifact.sizeBytes}\t${artifact.sha256}`)
    .join('\n');
  return `TATOEBA-SNAPSHOT-${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32)}`;
}
