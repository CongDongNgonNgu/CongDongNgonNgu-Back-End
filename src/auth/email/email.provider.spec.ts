import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ConfiguredEmailProvider, createEmailProvider, EMAIL_PROVIDER_REQUEST_TIMEOUT_MS, EmailDeliveryError } from './email.provider';

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

  it('sends Resend-compatible verification payloads without leaking generic template fields', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'uat-message-id' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const provider = new ConfiguredEmailProvider(
      undefined as never,
      'https://api.resend.com',
      'api-key',
      { transport: 'resend', from: 'CongDongNgonNgu <onboarding@resend.dev>' },
    );

    await provider.sendVerification({
      email: 'delivered@resend.dev',
      displayName: 'UAT User',
      token: 'verification-token',
    });

    const request = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.resend.com/emails');
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: 'CongDongNgonNgu <onboarding@resend.dev>',
      to: ['delivered@resend.dev'],
      subject: expect.any(String),
      html: expect.any(String),
      text: expect.any(String),
    });
    expect(body).not.toHaveProperty('template');
    expect(body).not.toHaveProperty('variables');
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer api-key' });
  });

  it('returns the provider message id for the safe UAT test email', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'uat-message-id' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const provider = new ConfiguredEmailProvider(
      undefined as never,
      'https://api.resend.com/emails',
      'api-key',
      { transport: 'resend', from: 'CongDongNgonNgu <onboarding@resend.dev>', allowUatTestEmail: true },
    );

    await expect(provider.sendUatTestEmail({
      correlationId: 'uat-correlation-id',
    })).resolves.toEqual({ providerMessageId: 'uat-message-id' });
  });

  it('enables the safe UAT test email through the non-production Resend factory path', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'uat-message-id' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const values: Record<string, unknown> = {
      'app.environment': 'development',
      'providers.email': 'resend',
      'providers.emailApiUrl': 'https://api.resend.com',
      'providers.emailApiKey': 'api-key',
      'providers.emailFrom': 'CongDongNgonNgu <onboarding@resend.dev>',
    };
    const provider = createEmailProvider({
      get: (key: string) => values[key],
    } as never);

    await expect((provider as ConfiguredEmailProvider).sendUatTestEmail({
      correlationId: 'uat-correlation-id',
    })).resolves.toEqual({ providerMessageId: 'uat-message-id' });
  });

  it('escapes dynamic verification content in the Resend HTML body', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'uat-message-id' }), { status: 200 }),
    );
    const provider = new ConfiguredEmailProvider(
      undefined as never,
      'https://api.resend.com',
      'api-key',
      { transport: 'resend', from: 'CongDongNgonNgu <onboarding@resend.dev>' },
    );

    await provider.sendVerification({
      email: 'delivered@resend.dev',
      displayName: '<img src=x onerror=alert(1)>',
      token: '<unsafe-token>',
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { html: string };
    expect(body.html).not.toContain('<img');
    expect(body.html).toContain('&lt;img');
    expect(body.html).toContain('&lt;unsafe-token&gt;');
  });

  it('does not expose the UAT test-email capability in production', async () => {
    const config = { get: () => 'production' };
    const provider = new ConfiguredEmailProvider(
      config as never,
      'https://api.resend.com',
      'api-key',
      { transport: 'resend', from: 'CongDongNgonNgu <onboarding@resend.dev>', allowUatTestEmail: true },
    );

    await expect(provider.sendUatTestEmail({
      correlationId: 'uat-correlation-id',
    })).rejects.toMatchObject({ name: 'EmailDeliveryError' });
  });

  it('preserves generic configured-provider success with an empty response body', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const provider = new ConfiguredEmailProvider(
      undefined as never,
      'https://mailer.example.test/send',
      'api-key',
    );

    await expect(provider.sendVerification({
      email: 'member@example.test',
      displayName: 'Member',
      token: 'verification-token',
    })).resolves.toBeUndefined();
  });

  it('sanitizes provider errors while retaining only the HTTP status for diagnostics', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ api_key: 'must-not-leak' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const provider = new ConfiguredEmailProvider(
      undefined as never,
      'https://api.resend.com/emails',
      'api-key',
      { transport: 'resend', from: 'CongDongNgonNgu <onboarding@resend.dev>', allowUatTestEmail: true },
    );

    await expect(provider.sendUatTestEmail({
      correlationId: 'uat-correlation-id',
    })).rejects.toMatchObject({
      name: 'EmailDeliveryError',
      message: 'Email delivery is unavailable',
      statusCode: 422,
    });
  });
});


describe('production Resend factory', () => {
  afterEach(() => { jest.restoreAllMocks(); });
  const values: Record<string, unknown> = {
    'app.environment': 'production',
    'providers.email': 'resend',
    'providers.emailApiUrl': 'https://api.resend.com',
    'providers.emailApiKey': 'fake-email-credential',
    'providers.emailFrom': 'Application <sender@example.test>',
  };
  const config = { get: (key: string) => values[key] };

  it.each(['sendVerification', 'sendPasswordReset'] as const)('uses Resend transport for %s in production', async (method) => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const provider = createEmailProvider(config as never);
    await provider[method]({ email: 'member@example.test', displayName: '<Member>', token: '<fake-token>' });
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.resend.com/emails');
    expect(body).toMatchObject({ from: values['providers.emailFrom'], to: ['member@example.test'], subject: method === 'sendVerification' ? '[CongDongNgonNgu] Verify your email' : '[CongDongNgonNgu] Reset your password', text: expect.any(String), html: expect.any(String) });
    expect(body.html).toContain('&lt;Member&gt;');
    expect(body.html).toContain('&lt;fake-token&gt;');
    expect(body).not.toHaveProperty('template');
    expect(body).not.toHaveProperty('variables');
    expect(JSON.stringify(body)).not.toContain('fake-email-credential');
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer fake-email-credential' });
    expect(request?.redirect).toBe('error');
  });

  it('blocks UAT test email before any network request, including a manually enabled option', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const providers = [createEmailProvider(config as never), new ConfiguredEmailProvider(config as never, 'https://api.resend.com', 'fake-email-credential', { transport: 'resend', from: 'sender@example.test', allowUatTestEmail: true })];
    for (const provider of providers) {
      await expect((provider as ConfiguredEmailProvider).sendUatTestEmail({ correlationId: 'fake-correlation' })).rejects.toBeInstanceOf(EmailDeliveryError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizes provider failures and rejects oversized responses', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fake-email-credential'));
    const provider = createEmailProvider(config as never);
    await expect(provider.sendVerification({ email: 'member@example.test', displayName: 'Member', token: 'fake-token' })).rejects.toThrow('Email delivery is unavailable');
    fetchMock.mockResolvedValue(new Response('x'.repeat(65537), { status: 200 }));
    await expect(provider.sendPasswordReset({ email: 'member@example.test', displayName: 'Member', token: 'fake-token' })).rejects.toThrow('Email delivery is unavailable');
  });
});
