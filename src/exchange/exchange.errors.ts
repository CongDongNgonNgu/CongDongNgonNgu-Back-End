import { HttpException } from '@nestjs/common';

export class ExchangeFailure extends HttpException {
  constructor(
    readonly code: string,
    status: number,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super({ code, message, ...(retryAfterSeconds ? {retryAfterSeconds} : {}) }, status);
    this.name = 'ExchangeFailure';
  }
}
