import { HttpException } from '@nestjs/common';

export type EventFailureCode =
  | 'EVENT_INVALID_INPUT'
  | 'EVENT_ACTOR_INVALID'
  | 'EVENT_LANGUAGE_UNAVAILABLE'
  | 'EVENT_NOT_FOUND'
  | 'EVENT_HOST_FORBIDDEN'
  | 'EVENT_VENUE_UNSUPPORTED'
  | 'EVENT_SPEAKING_ROOM_NOT_FOUND'
  | 'EVENT_SPEAKING_ROOM_HOST_FORBIDDEN'
  | 'EVENT_SPEAKING_ROOM_UNAVAILABLE'
  | 'EVENT_CANNOT_CANCEL';

export class EventFailure extends HttpException {
  constructor(
    readonly code: EventFailureCode,
    status: number,
    message: string,
  ) {
    super({ code, message }, status);
    this.name = 'EventFailure';
  }
}
