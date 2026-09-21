import { HttpException } from '@nestjs/common';

export class LibraryFailure extends HttpException {
  constructor(
    readonly code: string,
    status: number,
    message: string,
  ) {
    super({ code, message }, status);
    this.name = 'LibraryFailure';
  }
}

export function libraryFailure(
  code: string,
  message: string,
  status = 400,
): never {
  throw new LibraryFailure(code, status, message);
}
