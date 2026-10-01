export type SpeakingRoomVisibility = 'PUBLIC' | 'PRIVATE';
export type SpeakingRoomLifecycle = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';
export type SpeakingRoomParticipantRole = 'LISTENER' | 'SPEAKER' | 'HOST' | 'MODERATOR';

export interface SpeakingRoomRecord {
  id: string;
  hostUserId: string;
  languageCode: string;
  level: string | null;
  topic: string;
  visibility: SpeakingRoomVisibility;
  lifecycle: SpeakingRoomLifecycle;
  capacity: number;
  accessTokenHash: string | null;
  scheduledAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
