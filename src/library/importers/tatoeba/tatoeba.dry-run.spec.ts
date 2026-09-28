import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, jest } from '@jest/globals';

import {
  TATOEBA_MAX_REPORT_BYTES,
  TATOEBA_MAX_REPORT_QUARANTINE_ROWS,
} from './tatoeba.constants';
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
    const serializedReport = JSON.stringify(report);

    expect(report.dbPreflight).toBe('SKIPPED_08D3A');
    expect(report).toHaveProperty('runStartedAt', '2026-09-28T00:00:00.000Z');
    expect(report.snapshot).toHaveProperty('snapshotRetrievedAt', null);
    expect(serializedReport).not.toContain(directory);
    expect(report.candidates.sentences[0]).not.toHaveProperty('snapshot');
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

  it('caps candidate samples and keeps full processing counts while bounding JSON and JSONL output', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tatoeba-report-bound-'));
    const detailedPath = path.join(directory, 'sentences_detailed.csv');
    const cc0Path = path.join(directory, 'sentences_CC0.csv');
    const linksPath = path.join(directory, 'links.csv');
    const jsonPath = path.join(directory, 'report.json');
    const jsonlPath = path.join(directory, 'report.jsonl');
    const text = 'x'.repeat(12_000);
    const sentenceCount = 1_200;
    await fs.writeFile(
      detailedPath,
      Array.from(
        { length: sentenceCount },
        (_, index) => `${index + 1}\teng\t${text}\towner-${index + 1}\t2026-01-01\t2026-01-02`,
      ).join('\n') + '\n',
      'utf8',
    );
    await fs.writeFile(cc0Path, '', 'utf8');
    await fs.writeFile(linksPath, '', 'utf8');

    const getSentence = jest.fn(async (sentenceId: string): Promise<TatoebaApiSentenceCheck> => api(sentenceId, {
      tatoebaLanguage: 'eng',
      text,
      license: 'CC BY 2.0 FR',
      owner: `owner-${sentenceId}`,
    }));
    const report = await runTatoebaDryRun({
      sentencesDetailedPath: detailedPath,
      sentencesCc0Path: cc0Path,
      linksPath,
      languages: ['en'],
      directions: [],
      sentenceLimit: sentenceCount,
      linkLimit: 1,
      apiConcurrency: 8,
      apiTimeoutMs: 100,
      apiRetries: 0,
      apiMaxResponseBytes: 10_000,
      apiClient: { getSentence },
      now: () => '2026-09-28T00:00:00.000Z',
    });
    await writeTatoebaDryRunReport(report, jsonPath);
    await writeTatoebaDryRunReport(report, jsonlPath);
    const json = await fs.readFile(jsonPath, 'utf8');
    const jsonl = await fs.readFile(jsonlPath, 'utf8');

    expect(report.counts.sentencesEligible).toBe(sentenceCount);
    expect(report.counts.wouldCreateSentences).toBe(sentenceCount);
    expect(report.sentenceCandidatesTruncated).toBe(true);
    expect(report.sentenceCandidatesOmitted).toBe(sentenceCount - report.candidates.sentences.length);
    expect(report.candidates.sentences.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(TATOEBA_MAX_REPORT_BYTES);
    expect(Buffer.byteLength(jsonl, 'utf8')).toBeLessThanOrEqual(TATOEBA_MAX_REPORT_BYTES);
    expect((json.match(/"artifacts"/g) ?? []).length).toBe(1);
    expect(json).not.toContain(directory);
    expect(jsonl).not.toContain(directory);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('caps quarantine samples explicitly without changing malformed-row counts', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tatoeba-quarantine-bound-'));
    const detailedPath = path.join(directory, 'sentences_detailed.csv');
    const cc0Path = path.join(directory, 'sentences_CC0.csv');
    const linksPath = path.join(directory, 'links.csv');
    const reportPath = path.join(directory, 'report.jsonl');
    const malformedCount = TATOEBA_MAX_REPORT_QUARANTINE_ROWS + 17;
    await fs.writeFile(
      detailedPath,
      Array.from({ length: malformedCount }, (_, index) => `not-an-id-${index}\teng\ttext\towner\tdate`).join('\n') + '\n',
      'utf8',
    );
    await fs.writeFile(cc0Path, '', 'utf8');
    await fs.writeFile(linksPath, '', 'utf8');

    const report = await runTatoebaDryRun({
      sentencesDetailedPath: detailedPath,
      sentencesCc0Path: cc0Path,
      linksPath,
      languages: ['en'],
      directions: [],
      sentenceLimit: malformedCount,
      linkLimit: 1,
      apiClient: { getSentence: async () => api('1') },
      now: () => '2026-09-28T00:00:00.000Z',
    });
    await writeTatoebaDryRunReport(report, reportPath);
    const output = await fs.readFile(reportPath, 'utf8');

    expect(report.counts.malformedRows).toBe(malformedCount);
    expect(report.quarantineTruncated).toBe(true);
    expect(report.quarantineOmitted).toBe(malformedCount - report.quarantine.length);
    expect(report.quarantine.length).toBe(TATOEBA_MAX_REPORT_QUARANTINE_ROWS);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(TATOEBA_MAX_REPORT_BYTES);
    expect(output).not.toContain(directory);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps snapshot identity independent from run time and preserves trusted retrieval metadata', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tatoeba-clock-'));
    const detailedPath = path.join(directory, 'sentences_detailed.csv');
    const cc0Path = path.join(directory, 'sentences_CC0.csv');
    const linksPath = path.join(directory, 'links.csv');
    await fs.writeFile(detailedPath, '', 'utf8');
    await fs.writeFile(cc0Path, '', 'utf8');
    await fs.writeFile(linksPath, '', 'utf8');
    const baseOptions: TatoebaDryRunOptions = {
      sentencesDetailedPath: detailedPath,
      sentencesCc0Path: cc0Path,
      linksPath,
      languages: ['en'],
      directions: [],
      sentenceLimit: 1,
      linkLimit: 1,
    };

    const first = await runTatoebaDryRun({ ...baseOptions, now: () => '2026-09-28T01:00:00.000Z' });
    const second = await runTatoebaDryRun({ ...baseOptions, now: () => '2026-09-28T02:00:00.000Z' });
    const supplied = await runTatoebaDryRun({
      ...baseOptions,
      now: () => '2026-09-28T03:00:00.000Z',
      snapshotRetrievedAt: '2026-09-27T18:00:00+07:00',
    });

    expect(first.snapshot.snapshotId).toBe(second.snapshot.snapshotId);
    expect(first.runStartedAt).not.toBe(second.runStartedAt);
    expect(first.snapshot.snapshotRetrievedAt).toBeNull();
    expect(supplied.snapshot.snapshotRetrievedAt).toBe('2026-09-27T18:00:00+07:00');
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('does not build a translation from a sentence that fails Library text eligibility', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tatoeba-text-boundary-'));
    const detailedPath = path.join(directory, 'sentences_detailed.csv');
    const cc0Path = path.join(directory, 'sentences_CC0.csv');
    const linksPath = path.join(directory, 'links.csv');
    const overLimit = 'x'.repeat(20_001);
    await fs.writeFile(detailedPath, [
      `1\tvie\t${overLimit}\talice\t2026-01-01\t2026-01-02`,
      '2\teng\tok\tbob\t2026-01-01\t2026-01-02',
    ].join('\n') + '\n', 'utf8');
    await fs.writeFile(cc0Path, '', 'utf8');
    await fs.writeFile(linksPath, '1\t2\n', 'utf8');

    const getSentence = jest.fn(async (sentenceId: string): Promise<TatoebaApiSentenceCheck> => sentenceId === '1'
      ? api('1', { tatoebaLanguage: 'vie', text: overLimit, license: 'CC BY 2.0 FR', owner: 'alice' })
      : api('2', { tatoebaLanguage: 'eng', text: 'ok', license: 'CC BY 2.0 FR', owner: 'bob' }));

    const report = await runTatoebaDryRun({
      sentencesDetailedPath: detailedPath,
      sentencesCc0Path: cc0Path,
      linksPath,
      languages: ['vi', 'en'],
      directions: [{ sourceLanguage: 'vi', targetLanguage: 'en' }],
      sentenceLimit: 10,
      linkLimit: 10,
      apiClient: { getSentence },
      now: () => '2026-09-28T00:00:00.000Z',
    });

    expect(report.counts.textTooLong).toBe(1);
    expect(report.counts.sentencesEligible).toBe(1);
    expect(report.counts.translationCandidates).toBe(0);
    expect(report.counts.missingLinkEndpoints).toBe(1);
    expect(report.quarantine).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'TATOEBA_TEXT_TOO_LONG' }),
      expect.objectContaining({ reason: 'TATOEBA_LINK_ENDPOINT_NOT_ELIGIBLE' }),
    ]));
    await fs.rm(directory, { recursive: true, force: true });
  });
});
