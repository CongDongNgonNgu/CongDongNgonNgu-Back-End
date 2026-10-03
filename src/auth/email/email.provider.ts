import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const EMAIL_PROVIDER_REQUEST_TIMEOUT_MS = 10_000;

export interface EmailProvider {
  sendVerification(input: { email: string; displayName: string; token: string }): Promise<void>;
  sendPasswordReset(input: { email: string; displayName: string; token: string }): Promise<void>;
}

export interface ConfiguredEmailProviderOptions {
  transport: 'generic' | 'resend';
  from?: string;
  allowUatTestEmail?: boolean;
}

export const RESEND_UAT_TEST_RECIPIENT = 'delivered@resend.dev';

export class EmailDeliveryError extends Error {
  constructor(message = 'Email delivery is unavailable', public readonly statusCode?: number) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

export interface MemoryEmailMessage {
  kind: 'verification' | 'password-reset';
  email: string;
  displayName: string;
  token: string;
}

@Injectable()
export class MemoryEmailProvider implements EmailProvider {
  readonly messages: MemoryEmailMessage[] = [];

  async sendVerification(input: { email: string; displayName: string; token: string }): Promise<void> {
    this.messages.push({ kind: 'verification', ...input });
  }

  async sendPasswordReset(input: { email: string; displayName: string; token: string }): Promise<void> {
    this.messages.push({ kind: 'password-reset', ...input });
  }
}

@Injectable()
export class ConfiguredEmailProvider implements EmailProvider {
  constructor(
    private readonly config: ConfigService,
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly options: ConfiguredEmailProviderOptions = { transport: 'generic' },
  ) {}

  async sendVerification(input: { email: string; displayName: string; token: string }): Promise<void> {
    if (this.options.transport === 'resend') {
      await this.send({
        from: this.requireFrom(),
        to: [input.email],
        subject: '[CongDongNgonNgu] Verify your email',
        text: `Hello ${input.displayName}, your verification token is ${input.token}.`,
        html: `<p>Hello ${escapeHtml(input.displayName)}, your verification token is <code>${escapeHtml(input.token)}</code>.</p>`,
      });
      return;
    }
    await this.send({
      to: input.email,
      template: 'verification',
      variables: { displayName: input.displayName, token: input.token },
    });
  }

  async sendPasswordReset(input: { email: string; displayName: string; token: string }): Promise<void> {
    if (this.options.transport === 'resend') {
      await this.send({
        from: this.requireFrom(),
        to: [input.email],
        subject: '[CongDongNgonNgu] Reset your password',
        text: `Hello ${input.displayName}, your password reset token is ${input.token}.`,
        html: `<p>Hello ${escapeHtml(input.displayName)}, your password reset token is <code>${escapeHtml(input.token)}</code>.</p>`,
      });
      return;
    }
    await this.send({
      to: input.email,
      template: 'password-reset',
      variables: { displayName: input.displayName, token: input.token },
    });
  }

  async sendUatTestEmail(input: { correlationId: string }): Promise<{ providerMessageId: string }> {
    const environment = this.config?.get<string>('app.environment');
    if (this.options.transport !== 'resend' || this.options.allowUatTestEmail !== true || environment === 'production') {
      throw new EmailDeliveryError();
    }
    const correlationId = input.correlationId;
    if (!isSafeCorrelationId(correlationId)) throw new EmailDeliveryError();
    const response = await this.send({
      from: this.requireFrom(),
      to: [RESEND_UAT_TEST_RECIPIENT],
      subject: '[CongDongNgonNgu UAT] Phase 18 email verification',
      text: `Correlation ID: ${correlationId}`,
      html: `<p>Correlation ID: <code>${escapeHtml(correlationId)}</code></p>`,
    });
    const providerMessageId = typeof response?.id === 'string' ? response.id.trim() : undefined;
    if (!providerMessageId || !isSafeProviderMessageId(providerMessageId)) throw new EmailDeliveryError();
    return { providerMessageId };
  }

  private async send(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Email provider request timed out'));
      }, EMAIL_PROVIDER_REQUEST_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([
        fetch(this.options.transport === 'resend' ? resolveResendEmailsUrl(this.apiUrl) : this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + this.apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        timeoutPromise,
      ]).catch(() => null);
      if (!response) {
        throw new EmailDeliveryError();
      }
      if (!response.ok) throw new EmailDeliveryError('Email delivery is unavailable', response.status);
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > 64 * 1024) throw new EmailDeliveryError();
      const text = await Promise.race([response.text(), timeoutPromise]).catch(() => null);
      if (text === null || text.length > 64 * 1024) throw new EmailDeliveryError();
      if (!text) return null;
      try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {
        return null;
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private requireFrom(): string {
    if (this.options.transport !== 'resend' || !this.options.from) throw new EmailDeliveryError();
    return this.options.from;
  }
}

@Injectable()
export class FailClosedEmailProvider implements EmailProvider {
  async sendVerification(): Promise<void> {
    throw new EmailDeliveryError();
  }

  async sendPasswordReset(): Promise<void> {
    throw new EmailDeliveryError();
  }
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

export function createEmailProvider(config: ConfigService): EmailProvider {
  const environment = config.get<string>('app.environment');
  const provider = config.get<string>('providers.email');
  if (provider === 'configured' || provider === 'resend') {
    const apiUrl = config.get<string>('providers.emailApiUrl');
    const apiKey = config.get<string>('providers.emailApiKey');
    const from = config.get<string>('providers.emailFrom');
    if (apiUrl && apiKey && (provider === 'configured' || from)) {
      return new ConfiguredEmailProvider(config, apiUrl, apiKey, {
        transport: provider === 'resend' ? 'resend' : 'generic',
        ...(from ? { from } : {}),
        ...(provider === 'resend' && (environment === 'development' || environment === 'test')
          ? { allowUatTestEmail: true }
          : {}),
      });
    }
    return new FailClosedEmailProvider();
  }
  if (environment === 'production') return new FailClosedEmailProvider();
  return new MemoryEmailProvider();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

function isSafeCorrelationId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isSafeProviderMessageId(value: string): boolean {
  return value.length <= 256 && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function resolveResendEmailsUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/emails';
  return url.toString().replace(/\/$/u, '');
}
