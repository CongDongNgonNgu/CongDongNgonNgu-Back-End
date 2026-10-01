export type SpeakingRoomQueueState = 'WAITING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';
export type SpeakingRoomQueueActionType = 'RAISE_HAND' | 'CANCEL_HAND' | 'ACCEPT' | 'DECLINE';

export type SpeakingRoomModerationActionType =
  | 'MUTE'
  | 'UNMUTE'
  | 'REMOVE'
  | 'PROMOTE'
  | 'DEMOTE'
  | 'ACCEPT_QUEUE'
  | 'DECLINE_QUEUE'
  | 'BLOCK'
  | 'UNBLOCK'
  | 'REPORT';

export const SPEAKING_ROOM_REPORT_CATEGORIES = [
  'SPAM',
  'HARASSMENT',
  'INAPPROPRIATE_CONTENT',
  'SAFETY_CONCERN',
  'OTHER',
] as const;

export type SpeakingRoomReportCategory = typeof SPEAKING_ROOM_REPORT_CATEGORIES[number];

export interface SpeakingRoomQueueEntryRecord {
  id: string;
  roomId: string;
  participantId: string;
  userId: string;
  state: SpeakingRoomQueueState;
  createdAt: Date;
  updatedAt: Date;
  decidedAt: Date | null;
  decidedByUserId: string | null;
}

export interface SpeakingRoomModerationActionRecord {
  id: string;
  roomId: string;
  actorUserId: string;
  targetParticipantId: string;
  targetUserId: string;
  action: SpeakingRoomModerationActionType;
  reason: string | null;
  resultDuplicate?: boolean;
  createdAt: Date;
}

export interface SpeakingRoomChatMessageRecord {
  id: string;
  roomId: string;
  authorParticipantId: string;
  authorUserId: string;
  body: string;
  createdAt: Date;
}

export interface SpeakingRoomChatCursor {
  createdAt: Date;
  id: string;
}
