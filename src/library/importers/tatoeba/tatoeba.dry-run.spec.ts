import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, jest } from '@jest/globals';

import { runTatoebaDryRun, writeTatoebaDryRunReport } from './tatoeba.dry-run';
import type { TatoebaApiSentenceCheck, TatoebaDryRunOptions } from './tatoeba.dry-run';
import type { TatoebaApiSentenceFacts } from './tatoeba.types';

function api(sentenceId: string, facts: Partial<TatoebaApiSentenceFacts> = {}): TatoebaApiSentenceCheck {
  return {
    checkedAt: '2026-09-28T00:00:01.000Z',
    facts: {
      sentenceId,
      tatoebaLanguage: 'eng',
      text: `text-${sentenceId}`,
      license: 'CC0 1.0',
      owner: null,
      isUnapproved: false,
      ...facts,
    },
  };
}

describe('Tatoeba bounded dry-run orchestration', () => {
  it('uses only synthetic local rows, enriches bounded candidates, and emits no DB counts', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tatoeba-dry-run-'));
    const detailedPath = path.join(directory, 'sentences_detailed.csv');
    const cc0Path = path.join(directory, 'sentences_CC0.csv');
    const linksPath = path.join(directory, 'links.csv');
    const reportPath = path.join(directory, 'report.jsonl');
    await fs.writeFile(detailedPath, [
      '1\tvie\ttext-1\towner_1\t2026-01-01\t2026-01-02',
      '2\teng\ttext-2\t\t2026-01-01\t2026-01-02',
      '3\tcmn\ttext-3\towner_3\t2026-01-01\t2026-01-02',
      '4\tjpn\ttext-4\t\t2026-01-01\t2026-01-02',
      '5\tkor\ttext-5\towner_5\t2026-01-01\t2026-01-02',
      '6\tfra\ttext-6\t\t2026-01-01\t2026-01-02',
      '7\tdeu\ttext-7\towner_7\t2026-01-01\t2026-01-02',
      '8\tspa\ttext-8\t\t2026-01-01\t2026-01-02',
      '9\tzho\ttext-9\towner_9\t2026-01-01\t2026-01-02',
    ].join('\n') + '\n', 'utf8');
    await fs.writeFile(cc0Path, [
      '2\teng\ttext-2\t2026-01-02',
      '4\tjpn\ttext-4\t2026-01-02',
      '6\tfra\ttext-6\t2026-01-02',
      '8\tspa\ttext-8\t2026-01-02',
    ].join('\n') + '\n', 'utf8');
    await fs.writeFile(linksPath, '1\t2\n2\t1\n3\t4\n1\t999\n', 'utf8');

    const getSentence = jest.fn<(sentenceId: string) => Promise<TatoebaApiSentenceCheck>>();
    for (const [id, language, license, owner] of [
      ['1', 'vie', 'CC BY 2.0 FR', 'owner_1'],
      ['2', 'eng', 'CC0 1.0', null],
      ['3', 'cmn', 'CC BY 2.0 FR', 'owner_3'],
      ['4', 'jpn', 'CC0 1.0', null],
      ['5', 'kor', 'CC BY 2.0 FR', 'owner_5'],
      ['6', 'fra', 'CC0 1.0', null],
      ['7', 'deu', 'CC BY 2.0 FR', 'owner_7'],
      ['8', 'spa', 'CC0 1.0', null],
      ['9', 'zho', 'CC0 1.0', null],
    ] as const) {
      getSentence.mockResolvedValueOnce(api(id, { tatoebaLanguage: language, license, owner }));
    }

    const options: TatoebaDryRunOptions = {
      sentencesDetailedPath: detailedPath,
      sentencesCc0Path: cc0Path,
      linksPath,
      languages: ['vi', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es'],
      directions: [
        { sourceLanguage: 'vi', targetLanguage: 'en' },
        { sourceLanguage: 'zh', targetLanguage: 'ja' },
      ],
      sentenceLimit: 20,
      linkLimit: 20,
      apiConcurrency: 2,
      apiTimeoutMs: 100,
      apiRetries: 0,
      apiMaxResponseBytes: 10_000,
      apiClient: { getSentence },
      now: () => '2026-09-28T00:00:00.000Z',
    };
    const report = await runTatoebaDryRun(options);
    await writeTatoebaDryRunReport(report, reportPath);
    const reportText = await fs.readFile(reportPath, 'utf8');

    expect(report.dbPreflight).toBe('SKIPPED_08D3A');
    expect(report.counts.sentencesEligible).toBe(8);
    expect(report.counts.unsupportedLanguage).toBe(1);
    expect(report.counts.translationCandidates).toBe(2);
    expect(report.counts.reciprocalPairsCollapsed).toBe(1);
    expect(report.counts.wouldCreateSentences).toBe(8);
    expect(report.counts.wouldCreateTranslations).toBe(2);
    expect(report.candidates.translations.map((item) => item.durableIdentity)).toEqual([
      'TATOEBA:LINK:DIRECT:1:2',
      'TATOEBA:LINK:DIRECT:3:4',
    ]);
    expect(reportText).toContain('"type":"summary"');
    expect(reportText).toContain('TATOEBA:LINK:DIRECT:1:2');
    await fs.rm(directory, { recursive: true, force: true });
  });
});
