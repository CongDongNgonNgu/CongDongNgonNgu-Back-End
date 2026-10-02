import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ConfiguredEmailProvider, EMAIL_PROVIDER_REQUEST_TIMEOUT_MS, EmailDeliveryError } from './email.provider';

describe('ConfiguredEmailProvider', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('aborts a provider request that exceeds the bounded timeout', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      throw new Error('unreachable');
    });
    const provider = new ConfiguredEmailProvider(
      undefined as never,
      'https://mailer.example.test/send',
      'api-key',
    );

    const pending = expect(provider.sendVerification({
      email: 'member@example.test',
      displayName: 'Member',
      token: 'verification-token',
    })).rejects.toBeInstanceOf(EmailDeliveryError);
    await jest.advanceTimersByTimeAsync(EMAIL_PROVIDER_REQUEST_TIMEOUT_MS);

    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
