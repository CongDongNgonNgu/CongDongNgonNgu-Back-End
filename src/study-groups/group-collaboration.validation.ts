import type { MessageContextReference } from '../messaging/message-context';
import { bounded, invalid, uuid } from './study-group.validation';
export interface GroupTextInput {
  body?: unknown;
  clientMessageId?: unknown;
  contextType?: unknown;
  contextId?: unknown;
}
export interface GroupSyncInput {
  cursor?: unknown;
  limit?: unknown;
  renderedIds?: unknown;
}
export function normalizeGroupText(input: GroupTextInput): {
  body: string;
  clientMessageId: string | null;
  context: MessageContextReference | null;
} {
  let context: MessageContextReference | null = null;
  if (input.contextType !== undefined || input.contextId !== undefined) {
    if (
      (input.contextType !== 'LIBRARY_RESOURCE' &&
        input.contextType !== 'COMMUNITY_POST') ||
      typeof input.contextId !== 'string'
    )
      return invalid();
    uuid(input.contextId);
    context = { type: input.contextType, id: input.contextId.toLowerCase() };
  }
  let clientMessageId: string | null = null;
  if (input.clientMessageId !== undefined) {
    if (typeof input.clientMessageId !== 'string') return invalid();
    uuid(input.clientMessageId);
    clientMessageId = input.clientMessageId.toLowerCase();
  }
  const body = bounded(input.body ?? '', 2000, context !== null);
  if (
    /[\uD800-\uDFFF]/u.test(body) ||
    /\/study-groups\/invitations.*(?:token|invite)=/iu.test(body)
  )
    return invalid();
  return { body, clientMessageId, context };
}
export function normalizeGroupSync(input: GroupSyncInput): {
  cursor?: string;
  limit: number;
  renderedIds: string[];
} {
  const limit = input.limit ?? 20;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    return invalid();
  const renderedIds = input.renderedIds ?? [];
  if (
    !Array.isArray(renderedIds) ||
    renderedIds.length > 20 ||
    renderedIds.some((id) => typeof id !== 'string')
  )
    return invalid();
  renderedIds.forEach(uuid);
  if (
    new Set(renderedIds.map((id) => id.toLowerCase())).size !==
    renderedIds.length
  )
    return invalid();
  if (
    input.cursor !== undefined &&
    (typeof input.cursor !== 'string' || input.cursor.length > 2048)
  )
    return invalid();
  return {
    limit,
    renderedIds: renderedIds.map((id) => id.toLowerCase()),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }),
  };
}
