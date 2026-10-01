import { HttpException } from '@nestjs/common';

export class SpeakingRoomFailure extends HttpException {
  constructor(
    readonly code: string,
    status: number,
    message: string,
  ) {
    super({ code, message }, status);
    this.name = 'SpeakingRoomFailure';
  }
}

export function speakingRoomFailure(
  code: string,
  message: string,
  status = 400,
): never {
  throw new SpeakingRoomFailure(code, status, message);
}
