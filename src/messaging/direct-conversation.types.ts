export interface DirectConversationSummary {
  id: string;
  partner: { userId: string; displayName: string };
  headSequence: string;
  changeVersion: string;
  lastReadSequence: string;
  unreadCount: string;
  updatedAt: string;
}

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
}
