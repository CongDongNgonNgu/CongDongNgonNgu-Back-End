import { HttpException } from '@nestjs/common';

export class MessageFailure extends HttpException {
  constructor(readonly code: string, status: number, message: string, retryAfterSeconds?: number) {
    super({ code, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) }, status);
    this.name = 'MessageFailure';
  }
}

export function conversationUnavailable(): MessageFailure {
  return new MessageFailure('CONVERSATION_UNAVAILABLE', 404, 'Conversation was not found');
}
