import type {
  DialogueDetails,
  LibraryProvenanceRecord,
  LibraryPublicSearchResult,
  LibraryResourceDetails,
  LibraryResourceRecord,
} from './library.types';

const SEARCH_PREVIEW_TITLE_LENGTH = 160;
const SEARCH_PREVIEW_EXCERPT_LENGTH = 280;

export function normalizeLibrarySearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

export function libraryResourceMatchesQuery(
  resource: LibraryResourceRecord,
  query: string | null,
): boolean {
  if (!query) return true;
  const needle = normalizeLibrarySearchText(query);
  return libraryResourceSearchValues(resource)
    .some((value) => normalizeLibrarySearchText(value).includes(needle));
}

export function toPublicSearchResult(
  resource: LibraryResourceRecord,
  provenance: readonly LibraryProvenanceRecord[],
): LibraryPublicSearchResult {
  const preview = createSearchPreview(resource.details);
  return {
    id: resource.id,
    resourceType: resource.resourceType,
    primaryLanguageCode: resource.primaryLanguageCode,
    secondaryLanguageCode: resource.secondaryLanguageCode,
    cefrLevel: resource.cefrLevel,
    topics: [...resource.topics],
    reviewState: 'VERIFIED',
    preview,
    provenance: provenance.map((entry) => ({
      attribution: entry.attribution,
      license: {
        licenseKey: entry.license.licenseKey,
        displayName: entry.license.displayName,
        canonicalUrl: entry.license.canonicalUrl,
        attributionRequired: entry.license.attributionRequired,
        redistributionAllowed: entry.license.redistributionAllowed,
        derivativeConstraints: entry.license.derivativeConstraints,
      },
    })),
    createdAt: new Date(resource.createdAt),
    updatedAt: new Date(resource.updatedAt),
  };
}

export function toLibrarySearchPreview(
  details: LibraryResourceDetails,
): LibraryPublicSearchResult['preview'] {
  return createSearchPreview(details);
}

function libraryResourceSearchValues(resource: LibraryResourceRecord): string[] {
  return [
    ...resource.topics,
    ...detailsSearchValues(resource.details),
  ];
}

function detailsSearchValues(details: LibraryResourceDetails): string[] {
  switch (details.resourceType) {
    case 'VOCABULARY':
      return [details.term, details.definition, details.partOfSpeech ?? '', details.exampleSentence ?? ''];
    case 'SENTENCE':
      return [details.text, details.context ?? ''];
    case 'TRANSLATION':
      return [details.sourceText, details.translatedText];
    case 'GRAMMAR_ITEM':
      return [details.title, details.explanation, details.pattern ?? '', details.exampleText ?? ''];
    case 'DIALOGUE':
      return [details.title, ...dialogueSearchValues(details)];
    case 'IDIOM':
      return [details.expression, details.meaning, details.usageNote ?? ''];
    case 'SLANG':
      return [details.expression, details.meaning, details.register ?? '', details.usageNote ?? ''];
    case 'CULTURAL_NOTE':
      return [details.title, details.body];
    case 'PRONUNCIATION':
      return [details.term, details.phonetic, details.notes ?? ''];
    case 'LEARNING_COLLECTION':
      return [details.title, details.description];
  }
}

function dialogueSearchValues(details: DialogueDetails): string[] {
  return details.turns.flatMap((turn) => [turn.speaker, turn.text, turn.translation ?? '']);
}

function createSearchPreview(details: LibraryResourceDetails): LibraryPublicSearchResult['preview'] {
  switch (details.resourceType) {
    case 'VOCABULARY':
      return preview(details.term, details.definition);
    case 'SENTENCE':
      return preview('Sentence', details.text);
    case 'TRANSLATION':
      return preview(details.sourceText, details.translatedText);
    case 'GRAMMAR_ITEM':
      return preview(details.title, details.explanation);
    case 'DIALOGUE':
      return preview(details.title, details.turns[0]?.text ?? '');
    case 'IDIOM':
      return preview(details.expression, details.meaning);
    case 'SLANG':
      return preview(details.expression, details.meaning);
    case 'CULTURAL_NOTE':
      return preview(details.title, details.body);
    case 'PRONUNCIATION':
      return preview(details.term, details.phonetic + (details.notes ? ` · ${details.notes}` : ''));
    case 'LEARNING_COLLECTION':
      return preview(details.title, details.description);
  }
}

function preview(title: string, excerpt: string): LibraryPublicSearchResult['preview'] {
  return {
    title: takeCodePoints(title, SEARCH_PREVIEW_TITLE_LENGTH),
    excerpt: takeCodePoints(excerpt, SEARCH_PREVIEW_EXCERPT_LENGTH),
  };
}

function takeCodePoints(value: string, limit: number): string {
  const points = Array.from(value.normalize('NFKC').trim());
  return points.length > limit ? points.slice(0, limit).join('') + '…' : points.join('');
}
