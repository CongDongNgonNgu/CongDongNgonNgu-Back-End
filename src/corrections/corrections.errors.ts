import { HttpException } from '@nestjs/common';

export class CorrectionsFailure extends HttpException {
  constructor(
    readonly code: string,
    status: number,
    message: string,
  ) {
    super({ code, message }, status);
    this.name = 'CorrectionsFailure';
  }
}

export function correctionsFailure(
  code: string,
  message: string,
  status = 400,
): never {
  throw new CorrectionsFailure(code, status, message);
}
