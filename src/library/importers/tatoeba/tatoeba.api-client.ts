import { TextDecoder } from 'node:util';

import {
  TATOEBA_API_HOST,
  TATOEBA_API_ORIGIN,
  TATOEBA_DEFAULT_LIMITS,
  TATOEBA_MAX_API_RESPONSE_BYTES,
  TATOEBA_MAX_API_TIMEOUT_MS,
  TATOEBA_RETRY_AFTER_MAX_MS,
  TATOEBA_RETRY_BACKOFF_BASE_MS,
  TATOEBA_SUPPORTED_LICENSES,
} from './tatoeba.constants';
import { TatoebaImportError, tatoebaError } from './tatoeba.errors';
import { canonicalSentenceId } from './tatoeba.identities';
import type {
  TatoebaApiClientOptions,
  TatoebaApiSentenceCheck,
  TatoebaApiSentenceFacts,
  TatoebaApiTransport,
  TatoebaHttpRequest,
  TatoebaHttpResponse,
} from './tatoeba.types';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function assertSafeTatoebaApiUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw tatoebaError('TATOEBA_API_HOST_REJECTED', 'TATOEBA_API_HOST_REJECTED: API URL is invalid.');
  }
  const pathMatches = /^\/v1\/sentences\/[1-9][0-9]*$/.test(url.pathname);
  const queryKeys = [...url.searchParams.keys()];
  const safeQuery = queryKeys.length === 1 && queryKeys[0] === 'showtrans' && url.searchParams.get('showtrans') === 'none';
  if (
    url.origin !== TATOEBA_API_ORIGIN ||
    url.hostname !== TATOEBA_API_HOST ||
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    !pathMatches ||
    !safeQuery
  ) {
    throw tatoebaError('TATOEBA_API_HOST_REJECTED', 'TATOEBA_API_HOST_REJECTED: API URL is outside the allowlist.');
  }
  return url;
}

async function readBoundedFetchBody(response: Response, maxResponseBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxResponseBytes) {
      throw tatoebaError('TATOEBA_API_RESPONSE_TOO_LARGE', 'Tatoeba API response exceeds the configured byte bound.');
    }
  }

  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxResponseBytes) {
      throw tatoebaError('TATOEBA_API_RESPONSE_TOO_LARGE', 'Tatoeba API response exceeds the configured byte bound.');
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw tatoebaError('TATOEBA_API_RESPONSE_TOO_LARGE', 'Tatoeba API response exceeds the configured byte bound.');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const defaultTransport: TatoebaApiTransport = async (request: TatoebaHttpRequest): Promise<TatoebaHttpResponse> => {
  assertSafeTatoebaApiUrl(request.url);
  const response = await fetch(request.url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: request.signal,
  });
  return {
    status: response.status,
    headers: {
      'content-length': response.headers.get('content-length') ?? undefined,
      'retry-after': response.headers.get('retry-after') ?? undefined,
    },
    body: await readBoundedFetchBody(response, request.maxResponseBytes),
  };
};

function headerValue(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1];
}

function responseBodyText(body: string | Uint8Array, maxResponseBytes: number): string {
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > maxResponseBytes) {
      throw tatoebaError('TATOEBA_API_RESPONSE_TOO_LARGE', 'Tatoeba API response exceeds the configured byte bound.');
    }
    return body;
  }
  if (body.byteLength > maxResponseBytes) {
    throw tatoebaError('TATOEBA_API_RESPONSE_TOO_LARGE', 'Tatoeba API response exceeds the configured byte bound.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new TatoebaImportError('TATOEBA_API_MALFORMED_RESPONSE', 'Tatoeba API response is not valid UTF-8.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseApiSentence(payload: unknown, requestedId: string): TatoebaApiSentenceFacts {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new TatoebaImportError('TATOEBA_API_MALFORMED_RESPONSE', 'Tatoeba API response is missing data.');
  }
  const data = payload.data;
  const rawId = data.id;
  let sentenceId: string;
  if (typeof rawId === 'string' && /^[1-9][0-9]*$/.test(rawId)) {
    sentenceId = rawId;
  } else if (typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0) {
    sentenceId = String(rawId);
  } else {
    throw new TatoebaImportError('TATOEBA_API_MALFORMED_RESPONSE', 'Tatoeba API sentence ID is invalid.');
  }
  if (sentenceId !== requestedId) {
    throw new TatoebaImportError('TATOEBA_API_MALFORMED_RESPONSE', 'Tatoeba API returned a different sentence ID.');
  }
  if (typeof data.text !== 'string' || (typeof data.lang !== 'string' && data.lang !== null)) {
    throw new TatoebaImportError('TATOEBA_API_MALFORMED_RESPONSE', 'Tatoeba API sentence text or language is invalid.');
  }
  if (typeof data.is_unapproved !== 'boolean') {
    throw new TatoebaImportError('TATOEBA_API_MALFORMED_RESPONSE', 'Tatoeba API approval status is missing.');
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'owner')) {
    throw new TatoebaImportError('TATOEBA_OWNER_REQUIRED', 'Tatoeba API owner fact is missing.');
  }
  if (data.owner !== null && typeof data.owner !== 'string') {
    throw new TatoebaImportError('TATOEBA_API_MALFORMED_RESPONSE', 'Tatoeba API owner fact is invalid.');
  }

  const license = typeof data.license === 'string' ? data.license : null;
  if (data.is_unapproved) {
    throw new TatoebaImportError('TATOEBA_UNAPPROVED', 'Tatoeba sentence is marked unapproved.');
  }
  if (license === 'PROBLEM') {
    throw new TatoebaImportError('TATOEBA_LICENSE_PROBLEM', 'Tatoeba sentence has a licensing issue.');
  }
  if (!TATOEBA_SUPPORTED_LICENSES.includes(license as (typeof TATOEBA_SUPPORTED_LICENSES)[number])) {
    throw new TatoebaImportError('TATOEBA_LICENSE_UNKNOWN', 'Tatoeba sentence license is missing or unsupported.');
  }

  return {
    sentenceId,
    tatoebaLanguage: data.lang,
    text: data.text,
    license,
    owner: data.owner === null || data.owner.length === 0 ? null : data.owner,
    isUnapproved: false,
  };
}

function retryDelayMs(response: TatoebaHttpResponse, attempt: number): number {
  const retryAfter = headerValue(response.headers, 'retry-after');
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(TATOEBA_RETRY_AFTER_MAX_MS, Math.ceil(seconds * 1_000));
  }
  return Math.min(TATOEBA_RETRY_AFTER_MAX_MS, TATOEBA_RETRY_BACKOFF_BASE_MS * 2 ** attempt);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateOptionBounds(options: TatoebaApiClientOptions): Required<Pick<TatoebaApiClientOptions, 'timeoutMs' | 'retries' | 'maxResponseBytes'>> {
  const timeoutMs = options.timeoutMs ?? TATOEBA_DEFAULT_LIMITS.apiTimeoutMs;
  const retries = options.retries ?? TATOEBA_DEFAULT_LIMITS.apiRetries;
  const maxResponseBytes = options.maxResponseBytes ?? TATOEBA_DEFAULT_LIMITS.apiMaxResponseBytes;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > TATOEBA_MAX_API_TIMEOUT_MS ||
    !Number.isSafeInteger(retries) ||
    retries < 0 ||
    retries > 5 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0 ||
    maxResponseBytes > TATOEBA_MAX_API_RESPONSE_BYTES
  ) {
    throw tatoebaError('TATOEBA_IMPORT_ARGUMENT_INVALID', 'Tatoeba API bounds are outside the safe range.');
  }
  return { timeoutMs, retries, maxResponseBytes };
}

export class TatoebaSentenceApiClient {
  private readonly transport: TatoebaApiTransport;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => string;

  constructor(options: TatoebaApiClientOptions = {}) {
    const bounds = validateOptionBounds(options);
    this.transport = options.transport ?? defaultTransport;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = bounds.timeoutMs;
    this.retries = bounds.retries;
    this.maxResponseBytes = bounds.maxResponseBytes;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async getSentence(sentenceId: string): Promise<TatoebaApiSentenceCheck> {
    const canonicalId = canonicalSentenceId(sentenceId);
    const url = `${TATOEBA_API_ORIGIN}/v1/sentences/${encodeURIComponent(canonicalId)}?showtrans=none`;
    assertSafeTatoebaApiUrl(url);

    for (let attempt = 0; ; attempt += 1) {
      let response: TatoebaHttpResponse;
      try {
        response = await this.requestWithTimeout(url);
      } catch (error) {
        if (error instanceof TatoebaImportError && error.code !== 'TATOEBA_API_UNAVAILABLE') throw error;
        if (attempt >= this.retries) {
          throw new TatoebaImportError('TATOEBA_API_UNAVAILABLE', 'Tatoeba API request failed or timed out.');
        }
        await this.sleep(Math.min(TATOEBA_RETRY_AFTER_MAX_MS, TATOEBA_RETRY_BACKOFF_BASE_MS * 2 ** attempt));
        continue;
      }

      if (response.status === 404) {
        throw new TatoebaImportError('TATOEBA_API_NOT_FOUND', 'Tatoeba sentence was deleted or not found.');
      }
      if (RETRYABLE_STATUSES.has(response.status)) {
        if (attempt >= this.retries) {
          throw new TatoebaImportError('TATOEBA_API_UNAVAILABLE', 'Tatoeba API remained unavailable after bounded retries.');
        }
        await this.sleep(retryDelayMs(response, attempt));
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new TatoebaImportError('TATOEBA_API_UNAVAILABLE', `Tatoeba API returned HTTP ${response.status}.`);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(responseBodyText(response.body, this.maxResponseBytes)) as unknown;
      } catch (error) {
        if (error instanceof TatoebaImportError) throw error;
        throw new TatoebaImportError('TATOEBA_API_MALFORMED_RESPONSE', 'Tatoeba API response is not valid JSON.');
      }
      const facts = parseApiSentence(payload, canonicalId);
      return { facts, checkedAt: this.now() };
    }
  }

  private async requestWithTimeout(url: string): Promise<TatoebaHttpResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.transport({ url, signal: controller.signal, maxResponseBytes: this.maxResponseBytes });
    } catch (error) {
      if (error instanceof TatoebaImportError) throw error;
      throw new TatoebaImportError('TATOEBA_API_UNAVAILABLE', 'Tatoeba API request failed.');
    } finally {
      clearTimeout(timeout);
    }
  }
}
