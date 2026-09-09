import { HttpException } from '@nestjs/common';

export class AuthFailure extends HttpException {
  constructor(code: string, status: number, message: string) {
    super({ code, message }, status);
    this.name = 'AuthFailure';
  }
}

export function authFailure(
  code: string,
  status: number,
  message: string,
): never {
  throw new AuthFailure(code, status, message);
}
