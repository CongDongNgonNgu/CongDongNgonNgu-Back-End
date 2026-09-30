import { HttpException } from '@nestjs/common';

export class AiLearningFailure extends HttpException {
  constructor(readonly code: string, status: number, message: string) {
    super({ code, message }, status);
    this.name = 'AiLearningFailure';
  }
}
