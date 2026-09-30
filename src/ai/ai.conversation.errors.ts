import { HttpException } from '@nestjs/common';

export class AiConversationFailure extends HttpException {
  constructor(readonly code: string, status: number, message: string) {
    super({ code, message }, status);
    this.name = 'AiConversationFailure';
  }
}

export function aiConversationFailure(code: string, message: string, status = 400): never {
  throw new AiConversationFailure(code, status, message);
}
