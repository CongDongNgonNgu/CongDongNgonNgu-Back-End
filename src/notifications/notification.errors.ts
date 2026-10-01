import { HttpException } from '@nestjs/common';

export type NotificationFailureCode =
  | 'NOTIFICATION_INVALID_OWNER'
  | 'NOTIFICATION_INVALID_LIMIT'
  | 'NOTIFICATION_INVALID_CURSOR'
  | 'NOTIFICATION_INVALID_STREAM_CURSOR'
  | 'NOTIFICATION_STREAM_LIMIT'
  | 'NOTIFICATION_INVALID_IDS'
  | 'NOTIFICATION_NOT_FOUND';

export class NotificationFailure extends HttpException {
  constructor(
    readonly code: NotificationFailureCode,
    status: number,
    message: string,
  ) {
    super({ code, message }, status);
    this.name = 'NotificationFailure';
  }
}
