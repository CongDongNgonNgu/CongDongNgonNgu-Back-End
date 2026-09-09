import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EmailProvider {
  sendVerification(input: { email: string; displayName: string; token: string }): Promise<void>;
  sendPasswordReset(input: { email: string; displayName: string; token: string }): Promise<void>;
}

export class EmailDeliveryError extends Error {
  constructor(message = 'Email delivery is unavailable') {
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
  ) {}

  async sendVerification(input: { email: string; displayName: string; token: string }): Promise<void> {
    await this.send({
      to: input.email,
      template: 'verification',
      variables: { displayName: input.displayName, token: input.token },
    });
  }

  async sendPasswordReset(input: { email: string; displayName: string; token: string }): Promise<void> {
    await this.send({
      to: input.email,
      template: 'password-reset',
      variables: { displayName: input.displayName, token: input.token },
    });
  }

  private async send(body: Record<string, unknown>): Promise<void> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + this.apiKey,
      },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!response || !response.ok) {
      throw new EmailDeliveryError();
    }
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
  if (provider === 'configured') {
    const apiUrl = config.get<string>('providers.emailApiUrl');
    const apiKey = config.get<string>('providers.emailApiKey');
    if (apiUrl && apiKey) return new ConfiguredEmailProvider(config, apiUrl, apiKey);
  }
  if (environment === 'production') return new FailClosedEmailProvider();
  return new MemoryEmailProvider();
}
