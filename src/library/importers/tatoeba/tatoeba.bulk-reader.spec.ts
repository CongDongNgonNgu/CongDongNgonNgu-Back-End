import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  hashTatoebaArtifact,
  readCc0SentenceRows,
  readDetailedSentenceRows,
  readLinkRows,
} from './tatoeba.bulk-reader';

describe('Tatoeba strict bulk readers', () => {
  it('preserves exact text while accepting a documented header and BOM', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tatoeba-reader-'));
    const filePath = path.join(directory, 'sentences_detailed.csv');
    await fs.writeFile(
      filePath,
      '\uFEFFSentence id\tLang\tText\tUsername\tDate added\tDate last modified\r\n' +
        '123\tvie\t  Xin chào\towner_1\t2026-01-01\t2026-01-02\r\n',
      'utf8',
    );

    const rows = [];
    for await (const row of readDetailedSentenceRows(filePath, { maxRows: 1 })) rows.push(row);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sentenceId: '123',
      tatoebaLanguage: 'vie',
      text: '  Xin chào',
      username: 'owner_1',
    });
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('rejects malformed UTF-8 instead of replacing bytes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tatoeba-reader-'));
    const filePath = path.join(directory, 'sentences_detailed.csv');
    await fs.writeFile(filePath, Buffer.from([0x31, 0x09, 0xc3, 0x28, 0x09, 0x78, 0x09, 0x09, 0x78, 0x09, 0x78]));

    const read = async (): Promise<void> => {
      for await (const _row of readDetailedSentenceRows(filePath, { maxRows: 1 })) {
        // Exhaust the generator so the decoder validates the complete stream.
      }
    };

    await expect(read()).rejects.toMatchObject({ code: 'TATOEBA_INVALID_UTF8' });
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('parses CC0 membership and direct link rows without transitive expansion', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tatoeba-reader-'));
    const cc0Path = path.join(directory, 'sentences_CC0.csv');
    const linksPath = path.join(directory, 'links.csv');
    await fs.writeFile(cc0Path, '2\teng\tHello\t2026-01-02\n');
    await fs.writeFile(linksPath, '1\t2\n2\t1\n');

    const cc0Rows = [];
    for await (const row of readCc0SentenceRows(cc0Path, { maxRows: 10 })) cc0Rows.push(row);
    const linkRows = [];
    for await (const row of readLinkRows(linksPath, { maxRows: 10 })) linkRows.push(row);

    expect(cc0Rows[0].sentenceId).toBe('2');
    expect(linkRows.map((row) => [row.sentenceId, row.translationId])).toEqual([
      ['1', '2'],
      ['2', '1'],
    ]);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('hashes an artifact with a stable SHA-256 and reports its size', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tatoeba-reader-'));
    const filePath = path.join(directory, 'links.csv');
    await fs.writeFile(filePath, '1\t2\n', 'utf8');

    await expect(hashTatoebaArtifact('links', filePath)).resolves.toMatchObject({
      kind: 'links',
      fileName: 'links.csv',
      sizeBytes: 4,
      sha256: '0c944e60f2140df3aaa1c17f7e4ed1e3699bcf647cf9e38623180ff5e86ac971',
    });
    await fs.rm(directory, { recursive: true, force: true });
  });
});
