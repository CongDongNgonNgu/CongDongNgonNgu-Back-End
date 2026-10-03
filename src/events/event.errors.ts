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
  | 'EVENT_CANNOT_CANCEL'
  | 'EVENT_INVITE_REQUIRED'
  | 'EVENT_INVITE_FORBIDDEN'
  | 'EVENT_HOST_CANNOT_REGISTER'
  | 'EVENT_REGISTRATION_NOT_AVAILABLE'
  | 'EVENT_REGISTRATION_NOT_FOUND'
  | 'EVENT_REGISTRATION_CONFLICT'
  | 'EVENT_INTERNAL_ERROR'
  | 'EVENT_REMINDER_INVALID'
  | 'EVENT_ATTENDANCE_FORBIDDEN'
  | 'EVENT_ATTENDANCE_INVALID'
  | 'EVENT_ATTENDANCE_NOT_FOUND'
  | 'EVENT_ATTENDANCE_REPLAY_CONFLICT';

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
