import { HttpException } from '@nestjs/common';

export class OAuthFailure extends HttpException {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super({ code, message }, httpStatus);
    this.name = 'OAuthFailure';
  }
}
