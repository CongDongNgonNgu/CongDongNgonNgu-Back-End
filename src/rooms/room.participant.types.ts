import type { SpeakingRoomParticipantRole } from './room.types';

export type SpeakingRoomParticipantState = 'PRESENT' | 'DISCONNECTED' | 'LEFT' | 'REMOVED';
export type SpeakingRoomParticipantAction = 'JOIN' | 'HEARTBEAT' | 'LEAVE' | 'DISCONNECT';

export interface SpeakingRoomParticipantRecord {
  id: string;
  roomId: string;
  userId: string;
  deviceId: string;
  joinRequestId: string;
  role: SpeakingRoomParticipantRole;
  state: SpeakingRoomParticipantState;
  joinedAt: Date;
  lastSeenAt: Date;
  disconnectedAt: Date | null;
  leftAt: Date | null;
  updatedAt: Date;
}

export interface SpeakingRoomParticipantCounts {
  participantCount: number;
  speakerCount: number;
  listenerCount: number;
}
