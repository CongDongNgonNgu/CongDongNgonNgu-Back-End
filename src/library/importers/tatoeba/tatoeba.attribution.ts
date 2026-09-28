import {
  TATOEBA_LICENSE_URLS,
  TATOEBA_MAX_ATTRIBUTION_LENGTH,
  TATOEBA_SENTENCE_URL_ORIGIN,
} from './tatoeba.constants';
import { tatoebaError } from './tatoeba.errors';
import { canonicalSentenceId } from './tatoeba.identities';
import type { TatoebaLicense } from './tatoeba.types';

export function sentenceSourceUrl(sentenceId: string): string {
  return `${TATOEBA_SENTENCE_URL_ORIGIN}/${encodeURIComponent(canonicalSentenceId(sentenceId))}`;
}

export interface TatoebaAttributionInput {
  sentenceId: string;
  sourceUrl: string;
  license: TatoebaLicense;
  owner: string | null;
  transformationNote: string | null;
}

export function buildTatoebaAttribution(input: TatoebaAttributionInput): string {
  const sentenceId = canonicalSentenceId(input.sentenceId);
  if (input.sourceUrl !== sentenceSourceUrl(sentenceId)) {
    throw tatoebaError('TATOEBA_API_HOST_REJECTED', 'Tatoeba source URL is not the canonical sentence URL.');
  }
  if (input.license === 'CC BY 2.0 FR' && !input.owner) {
    throw tatoebaError('TATOEBA_OWNER_REQUIRED', 'CC BY attribution requires a sentence owner.');
  }

  const ownerText = input.owner ? ` by ${input.owner}` : '';
  const licenseText = input.license === 'CC BY 2.0 FR' ? 'CC BY 2.0 France' : 'CC0 1.0';
  let attribution = `Tatoeba sentence ${sentenceId}${ownerText}. Licensed under ${licenseText} (${TATOEBA_LICENSE_URLS[input.license]}). Source: ${input.sourceUrl}.`;
  if (input.transformationNote) attribution += ` Modified: ${input.transformationNote}.`;
  if (attribution.length > TATOEBA_MAX_ATTRIBUTION_LENGTH) {
    throw tatoebaError('TATOEBA_REPORT_WRITE_FAILED', 'Tatoeba attribution exceeds the Library attribution bound.');
  }
  return attribution;
}
