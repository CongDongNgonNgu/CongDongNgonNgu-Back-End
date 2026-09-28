import { describe, expect, it, jest } from '@jest/globals';

import {
  assertSafeTatoebaApiUrl,
  TatoebaSentenceApiClient,
} from './tatoeba.api-client';
import type { TatoebaApiTransport, TatoebaHttpResponse } from './tatoeba.types';

function response(body: unknown, status = 200, headers: Record<string, string> = {}): TatoebaHttpResponse {
  return { status, headers, body: JSON.stringify(body) };
}

describe('Tatoeba v1 sentence API client', () => {
  it('uses the stable read-only sentence endpoint and parses the required facts', async () => {
    const transport = jest.fn<TatoebaApiTransport>().mockResolvedValue(
      response({
        data: {
          id: 123,
          text: 'Xin chào',
          lang: 'vie',
          license: 'CC BY 2.0 FR',
          owner: 'owner_1',
          is_unapproved: false,
        },
      }),
    );
    const client = new TatoebaSentenceApiClient({
      transport,
      now: () => '2026-09-28T00:00:00.000Z',
    });

    await expect(client.getSentence('123')).resolves.toEqual({
      checkedAt: '2026-09-28T00:00:00.000Z',
      facts: {
        sentenceId: '123',
        tatoebaLanguage: 'vie',
        text: 'Xin chào',
        license: 'CC BY 2.0 FR',
        owner: 'owner_1',
        isUnapproved: false,
      },
    });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.tatoeba.org/v1/sentences/123?showtrans=none',
      maxResponseBytes: 128_000,
    }));
  });

  it('accepts CC0 with a null owner and does not infer CC BY', async () => {
    const transport = jest.fn<TatoebaApiTransport>().mockResolvedValue(response({
      data: {
        id: '124',
        text: 'Hello',
        lang: 'eng',
        license: 'CC0 1.0',
        owner: null,
        is_unapproved: false,
      },
    }));

    await expect(new TatoebaSentenceApiClient({ transport }).getSentence('124')).resolves.toMatchObject({
      facts: { license: 'CC0 1.0', owner: null },
    });
  });

  it('fails closed for PROBLEM and unapproved responses without retrying', async () => {
    const problemTransport = jest.fn<TatoebaApiTransport>().mockResolvedValue(response({
      data: { id: 1, text: 'x', lang: 'eng', license: 'PROBLEM', owner: 'owner', is_unapproved: false },
    }));
    const unapprovedTransport = jest.fn<TatoebaApiTransport>().mockResolvedValue(response({
      data: { id: 2, text: 'x', lang: 'eng', license: 'CC BY 2.0 FR', owner: 'owner', is_unapproved: true },
    }));

    await expect(new TatoebaSentenceApiClient({ transport: problemTransport }).getSentence('1'))
      .rejects.toMatchObject({ code: 'TATOEBA_LICENSE_PROBLEM' });
    await expect(new TatoebaSentenceApiClient({ transport: unapprovedTransport }).getSentence('2'))
      .rejects.toMatchObject({ code: 'TATOEBA_UNAPPROVED' });
    expect(problemTransport).toHaveBeenCalledTimes(1);
    expect(unapprovedTransport).toHaveBeenCalledTimes(1);
  });

  it('retries only bounded transient responses and caps Retry-After', async () => {
    const transport = jest
      .fn<TatoebaApiTransport>()
      .mockResolvedValueOnce(response({ error: 'busy' }, 503, { 'retry-after': '99' }))
      .mockResolvedValueOnce(response({
        data: { id: 3, text: '你好', lang: 'cmn', license: 'CC0 1.0', owner: null, is_unapproved: false },
      }));
    const sleep = jest.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(new TatoebaSentenceApiClient({ transport, retries: 1, sleep }).getSentence('3')).resolves.toBeDefined();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('does not retry a deleted/404 sentence and rejects unsafe URLs', async () => {
    const transport = jest.fn<TatoebaApiTransport>().mockResolvedValue(response({ error: 'missing' }, 404));
    await expect(new TatoebaSentenceApiClient({ transport, retries: 3 }).getSentence('4'))
      .rejects.toMatchObject({ code: 'TATOEBA_API_NOT_FOUND' });
    expect(transport).toHaveBeenCalledTimes(1);

    expect(() => assertSafeTatoebaApiUrl('http://api.tatoeba.org/v1/sentences/1')).toThrow('TATOEBA_API_HOST_REJECTED');
    expect(() => assertSafeTatoebaApiUrl('https://evil.example/v1/sentences/1')).toThrow('TATOEBA_API_HOST_REJECTED');
    expect(() => assertSafeTatoebaApiUrl('https://api.tatoeba.org/v1/sentences/1?next=https://evil.example'))
      .toThrow('TATOEBA_API_HOST_REJECTED');
  });

  it('rejects oversized API bodies and unbounded client settings', async () => {
    const transport = jest.fn<TatoebaApiTransport>().mockResolvedValue({
      status: 200,
      headers: {},
      body: 'x'.repeat(20),
    });
    await expect(new TatoebaSentenceApiClient({ transport, maxResponseBytes: 10 }).getSentence('5'))
      .rejects.toMatchObject({ code: 'TATOEBA_API_RESPONSE_TOO_LARGE' });
    expect(() => new TatoebaSentenceApiClient({ timeoutMs: 60_001 })).toThrow('Tatoeba API bounds are outside the safe range.');
  });
});
