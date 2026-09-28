import { describe, expect, it, jest } from '@jest/globals';

import { executeTatoebaCli, parseTatoebaCliArgs } from './library-import-tatoeba';

describe('Tatoeba importer CLI boundary', () => {
  it('rejects any invocation without the explicit dry-run flag before opening inputs', async () => {
    const output = { write: jest.fn() };
    const error = { write: jest.fn() };

    const exitCode = await executeTatoebaCli([], output, error);

    expect(exitCode).not.toBe(0);
    expect(error.write).toHaveBeenCalledWith(expect.stringContaining('TATOEBA_IMPORT_WRITE_MODE_NOT_IMPLEMENTED'));
  });

  it('requires finite bounds and parses explicit languages/directions', () => {
    const args = parseTatoebaCliArgs([
      '--dry-run',
      '--sentences-detailed', 'sentences_detailed.csv',
      '--sentences-cc0', 'sentences_CC0.csv',
      '--links', 'links.csv',
      '--sentence-limit', '10',
      '--link-limit', '20',
      '--languages', 'vi,en',
      '--directions', 'vi:en',
      '--api-concurrency', '2',
      '--api-timeout-ms', '1000',
      '--api-retries', '1',
      '--api-max-response-bytes', '5000',
    ]);

    expect(args).toMatchObject({
      dryRun: true,
      sentencesDetailedPath: 'sentences_detailed.csv',
      sentenceLimit: 10,
      linkLimit: 20,
      languages: ['vi', 'en'],
      directions: [{ sourceLanguage: 'vi', targetLanguage: 'en' }],
    });
  });
});
