import { HttpException } from '@nestjs/common';

export class AdminModerationFailure extends HttpException {
  constructor(
    readonly code: string,
    status: number,
    message: string,
  ) {
    super({ code, message }, status);
    this.name = 'AdminModerationFailure';
  }
}

export function adminModerationFailure(
  code: string,
  message: string,
  status = 400,
): never {
  throw new AdminModerationFailure(code, status, message);
}
