import type { MessageContextCard } from './message-context-resolver';

export interface DirectConversationSummary {
  id: string;
  partner: { userId: string; displayName: string };
  headSequence: string;
  changeVersion: string;
  lastReadSequence: string;
  unreadCount: string;
  updatedAt: string;
}

export interface DirectConversationListInput { limit?: number; cursor?: string }
export interface DirectConversationPage { items: DirectConversationSummary[]; nextCursor: string | null }

export interface DirectConversationRow {
  id: string;
  participant_a_id: string;
  participant_b_id: string;
  next_sequence: string;
  change_version: string;
  last_read_a: string;
  last_read_b: string;
  updated_at: Date;
}

export interface DirectMessage {
  id: string;
  conversationId: string;
  senderUserId: string;
  sequence: string;
  text: string;
  clientMessageId: string;
  createdAt: string;
  context?: MessageContextCard | null;
}

export interface MessageHistoryInput { limit?: number; before?: string; after?: string }
export interface MessageHistoryPage {
  items: DirectMessage[];
  nextCursor: string | null;
  beforeCursor: string;
  afterCursor: string;
}
