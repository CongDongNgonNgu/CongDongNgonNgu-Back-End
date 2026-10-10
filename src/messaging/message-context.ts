import { MessageFailure } from './message-failure';
import { normalizeMessageText } from './message-validation';

export type MessageContextType = 'LIBRARY_RESOURCE' | 'COMMUNITY_POST';
export interface MessageContextReference { type: MessageContextType; id: string }
export interface MessagePayloadInput {
  text?: unknown;
  contextType?: unknown;
  contextId?: unknown;
}
export interface NormalizedMessagePayload {
  text: string;
  context: MessageContextReference | null;
}

// Syntax only: a reference never grants target access. The canonical domain
// resolver must authorize it inside the protected send operation before commit.
export function normalizeMessagePayload(input: MessagePayloadInput): NormalizedMessagePayload {
  let context: MessageContextReference | null = null;
  if (input.contextType !== undefined || input.contextId !== undefined) {
    if ((input.contextType !== 'LIBRARY_RESOURCE' && input.contextType !== 'COMMUNITY_POST')
      || typeof input.contextId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.contextId)) {
      throw new MessageFailure('MESSAGE_INVALID_CONTEXT', 400, 'Message context reference is invalid');
    }
    context = { type: input.contextType, id: input.contextId.toLowerCase() };
  }
  return { text: normalizeMessageText(context && input.text == null ? '' : input.text, context !== null), context };
}
