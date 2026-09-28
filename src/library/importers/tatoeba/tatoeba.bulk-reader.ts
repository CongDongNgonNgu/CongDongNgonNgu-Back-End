import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { createReadStream } from 'node:fs';
import { TextDecoder } from 'node:util';

import {
  TATOEBA_EXPORT_COLUMNS,
  TATOEBA_MAX_CC0_SCAN_ROWS,
  TATOEBA_MAX_LINE_LENGTH,
} from './tatoeba.constants';
import { TatoebaImportError, tatoebaError } from './tatoeba.errors';
import { canonicalSentenceId } from './tatoeba.identities';
import type {
  TatoebaBulkSentenceRow,
  TatoebaCc0SentenceRow,
  TatoebaLinkRow,
  TatoebaSnapshotArtifact,
} from './tatoeba.types';

export interface TatoebaReaderOptions {
  maxRows?: number;
  maxLineLength?: number;
  onMalformed?: (error: TatoebaImportError) => void;
}

interface TatoebaLine {
  line: string;
  lineNumber: number;
}

const KNOWN_HEADERS = {
  sentencesDetailed: ['Sentence id', 'Lang', 'Text', 'Username', 'Date added', 'Date last modified'],
  sentencesCc0: ['Sentence id', 'Lang', 'Text', 'Date last modified'],
  links: ['Sentence id', 'Translation id'],
} as const;

async function* readUtf8Lines(
  filePath: string,
  maxLineLength: number,
  artifact: TatoebaSnapshotArtifact['kind'],
): AsyncGenerator<TatoebaLine, void, void> {
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let lineNumber = 0;
  let firstDecodedChunk = true;

  try {
    for await (const chunk of stream) {
      let decoded: string;
      try {
        decoded = decoder.decode(chunk as Uint8Array, { stream: true });
      } catch {
        throw new TatoebaImportError('TATOEBA_INVALID_UTF8', 'Tatoeba export is not valid UTF-8.');
      }
      if (firstDecodedChunk) {
        firstDecodedChunk = false;
        if (decoded.startsWith('\uFEFF')) decoded = decoded.slice(1);
      }
      buffer += decoded;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        lineNumber += 1;
        if (line.length > maxLineLength) {
          throw tatoebaError('TATOEBA_LINE_TOO_LONG', 'Tatoeba export row exceeds the configured line bound.', {
            artifact,
            lineNumber,
          });
        }
        yield { line, lineNumber };
        newlineIndex = buffer.indexOf('\n');
      }
      if (buffer.length > maxLineLength) {
        throw tatoebaError('TATOEBA_LINE_TOO_LONG', 'Tatoeba export row exceeds the configured line bound.', {
          artifact,
          lineNumber: lineNumber + 1,
        });
      }
    }

    let tail: string;
    try {
      tail = decoder.decode();
    } catch {
      throw new TatoebaImportError('TATOEBA_INVALID_UTF8', 'Tatoeba export is not valid UTF-8.');
    }
    buffer += tail;
    if (buffer.length > 0) {
      if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
      lineNumber += 1;
      if (buffer.length > maxLineLength) {
        throw tatoebaError('TATOEBA_LINE_TOO_LONG', 'Tatoeba export row exceeds the configured line bound.', {
          filePath,
          lineNumber,
        });
      }
      yield { line: buffer, lineNumber };
    }
  } finally {
    stream.destroy();
  }
}

function normalizedOptions(options: TatoebaReaderOptions): Required<TatoebaReaderOptions> {
  const maxRows = options.maxRows ?? TATOEBA_MAX_CC0_SCAN_ROWS;
  const maxLineLength = options.maxLineLength ?? TATOEBA_MAX_LINE_LENGTH;
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows <= 0 ||
    maxRows > TATOEBA_MAX_CC0_SCAN_ROWS + 1 ||
    !Number.isSafeInteger(maxLineLength) ||
    maxLineLength <= 0 ||
    maxLineLength > TATOEBA_MAX_LINE_LENGTH
  ) {
    throw tatoebaError('TATOEBA_INPUT_LIMIT_EXCEEDED', 'Reader bounds must be positive safe integers.');
  }
  return { maxRows, maxLineLength, onMalformed: options.onMalformed ?? (() => undefined) };
}

function parseFields(line: TatoebaLine, artifact: TatoebaSnapshotArtifact['kind'], expectedColumns: number): string[] {
  const fields = line.line.split('\t');
  if (fields.length !== expectedColumns || fields.some((field, index) => index < 3 && field.length === 0)) {
    throw tatoebaError('TATOEBA_MALFORMED_BULK_ROW', 'Tatoeba export row has an unexpected shape.', {
      artifact,
      lineNumber: line.lineNumber,
      expectedColumns,
      actualColumns: fields.length,
    });
  }
  return fields;
}

function isKnownHeader(fields: readonly string[], kind: keyof typeof KNOWN_HEADERS): boolean {
  const header = KNOWN_HEADERS[kind];
  return fields.length === header.length && fields.every((field, index) => field === header[index]);
}

function parseId(value: string, artifact: TatoebaSnapshotArtifact['kind'], lineNumber: number): string {
  try {
    return canonicalSentenceId(value);
  } catch (error) {
    if (error instanceof TatoebaImportError) {
      throw tatoebaError('TATOEBA_MALFORMED_BULK_ROW', 'Tatoeba export row has an invalid sentence ID.', {
        artifact,
        lineNumber,
      });
    }
    throw error;
  }
}

function nullableUsername(value: string): string | null {
  return value.length === 0 ? null : value;
}

export async function* readDetailedSentenceRows(
  filePath: string,
  options: TatoebaReaderOptions = {},
): AsyncGenerator<TatoebaBulkSentenceRow, void, void> {
  const bounds = normalizedOptions(options);
  let parsedRows = 0;
  for await (const line of readUtf8Lines(filePath, bounds.maxLineLength, 'sentences_detailed')) {
    const fields = line.line.split('\t');
    if (line.lineNumber === 1 && isKnownHeader(fields, 'sentencesDetailed')) continue;
    parsedRows += 1;
    try {
      const row = parseFields(line, 'sentences_detailed', TATOEBA_EXPORT_COLUMNS.sentencesDetailed);
      yield {
        sentenceId: parseId(row[0], 'sentences_detailed', line.lineNumber),
        tatoebaLanguage: row[1],
        text: row[2],
        username: nullableUsername(row[3]),
        dateAdded: row[4],
        dateLastModified: row[5],
        lineNumber: line.lineNumber,
      };
    } catch (error) {
      if (error instanceof TatoebaImportError && error.code === 'TATOEBA_MALFORMED_BULK_ROW') {
        bounds.onMalformed(error);
      } else {
        throw error;
      }
    }
    if (parsedRows >= bounds.maxRows) return;
  }
}

export async function* readCc0SentenceRows(
  filePath: string,
  options: TatoebaReaderOptions = {},
): AsyncGenerator<TatoebaCc0SentenceRow, void, void> {
  const bounds = normalizedOptions(options);
  let parsedRows = 0;
  for await (const line of readUtf8Lines(filePath, bounds.maxLineLength, 'sentences_cc0')) {
    const fields = line.line.split('\t');
    if (line.lineNumber === 1 && isKnownHeader(fields, 'sentencesCc0')) continue;
    parsedRows += 1;
    try {
      const row = parseFields(line, 'sentences_cc0', TATOEBA_EXPORT_COLUMNS.sentencesCc0);
      yield {
        sentenceId: parseId(row[0], 'sentences_cc0', line.lineNumber),
        tatoebaLanguage: row[1],
        text: row[2],
        dateLastModified: row[3],
        lineNumber: line.lineNumber,
      };
    } catch (error) {
      if (error instanceof TatoebaImportError && error.code === 'TATOEBA_MALFORMED_BULK_ROW') {
        bounds.onMalformed(error);
      } else {
        throw error;
      }
    }
    if (parsedRows >= bounds.maxRows) return;
  }
}

export async function* readLinkRows(
  filePath: string,
  options: TatoebaReaderOptions = {},
): AsyncGenerator<TatoebaLinkRow, void, void> {
  const bounds = normalizedOptions(options);
  let parsedRows = 0;
  for await (const line of readUtf8Lines(filePath, bounds.maxLineLength, 'links')) {
    const fields = line.line.split('\t');
    if (line.lineNumber === 1 && isKnownHeader(fields, 'links')) continue;
    parsedRows += 1;
    try {
      const row = parseFields(line, 'links', TATOEBA_EXPORT_COLUMNS.links);
      yield {
        sentenceId: parseId(row[0], 'links', line.lineNumber),
        translationId: parseId(row[1], 'links', line.lineNumber),
        lineNumber: line.lineNumber,
      };
    } catch (error) {
      if (error instanceof TatoebaImportError && error.code === 'TATOEBA_MALFORMED_BULK_ROW') {
        bounds.onMalformed(error);
      } else {
        throw error;
      }
    }
    if (parsedRows >= bounds.maxRows) return;
  }
}

export async function hashTatoebaArtifact(
  kind: TatoebaSnapshotArtifact['kind'],
  filePath: string,
): Promise<TatoebaSnapshotArtifact> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw tatoebaError('TATOEBA_MALFORMED_BULK_ROW', 'Tatoeba artifact path is not a file.', { artifact: kind });
  const hash = createHash('sha256');
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) hash.update(chunk as Uint8Array);
  } finally {
    stream.destroy();
  }
  return {
    kind,
    fileName: basename(filePath),
    sizeBytes: stat.size,
    sha256: hash.digest('hex'),
  };
}
