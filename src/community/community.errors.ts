import { HttpException } from '@nestjs/common';

export class CommunityFailure extends HttpException {
  constructor(
    readonly code: string,
    status: number,
    message: string,
  ) {
    super({ code, message }, status);
    this.name = 'CommunityFailure';
  }
}

export function communityFailure(
  code: string,
  message: string,
  status = 400,
): never {
  throw new CommunityFailure(code, status, message);
}
