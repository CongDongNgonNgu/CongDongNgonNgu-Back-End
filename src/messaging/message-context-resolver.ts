import { Logger } from '@nestjs/common';
import { CommunityFailure } from '../community/community.errors';
import type { CommunityService } from '../community/community.service';
import type { LibraryService } from '../library/library.service';
import { toLibrarySearchPreview } from '../library/library.search';
import type { LibraryResourceType } from '../library/library.types';
import { normalizeMessagePayload, type MessageContextReference } from './message-context';
import { MessageFailure } from './message-failure';

export type MessageContextCard = { availability: 'UNAVAILABLE' } | {
  availability: 'AVAILABLE';
  type: MessageContextReference['type'];
  id: string;
  category: LibraryResourceType | 'DISCUSSION' | 'QUESTION';
  languageCode: string;
  previewText: string;
  canonicalPath: string;
};

export class MessageContextResolver {
  private readonly logger = new Logger(MessageContextResolver.name);
  constructor(private readonly library: Pick<LibraryService, 'getPublicResource'>,
    private readonly community: Pick<CommunityService, 'getPost'>) {}

  async resolve(actor: string, input: MessageContextReference): Promise<MessageContextCard> {
    let reference: MessageContextReference;
    try {
      reference = normalizeMessagePayload({ contextType: input.type, contextId: input.id }).context!;
    } catch (error) {
      if (!(error instanceof MessageFailure) || error.code !== 'MESSAGE_INVALID_CONTEXT') throw error;
      // Corrupt persisted reference: no raw payload/identity in logs or response.
      this.logger.warn('MESSAGE_CONTEXT_REFERENCE_INVALID');
      return { availability: 'UNAVAILABLE' };
    }
    if (reference.type === 'LIBRARY_RESOURCE') {
      const resource = await this.library.getPublicResource(reference.id);
      if (!resource || resource.id !== reference.id) return { availability: 'UNAVAILABLE' };
      const preview = toLibrarySearchPreview(resource.details);
      return { availability: 'AVAILABLE', ...reference, category: resource.resourceType,
        languageCode: resource.primaryLanguageCode,
        previewText: prefix(resource.resourceType === 'SENTENCE' ? preview.excerpt : preview.title, 160),
        canonicalPath: '/library/' + reference.id };
    }
    try {
      const post = await this.community.getPost(reference.id, actor);
      if (post.id !== reference.id || post.visibility !== 'PUBLIC'
        || (post.postType !== 'DISCUSSION' && post.postType !== 'QUESTION')) return { availability: 'UNAVAILABLE' };
      return { availability: 'AVAILABLE', ...reference, category: post.postType,
        languageCode: post.targetLanguage.code, previewText: prefix(post.content, 120),
        canonicalPath: '/community/posts/' + reference.id };
    } catch (error) {
      if (error instanceof CommunityFailure && error.getStatus() === 404
        && error.code === 'COMMUNITY_POST_UNAVAILABLE') return { availability: 'UNAVAILABLE' };
      throw error;
    }
  }

  async resolvePage(actor: string, references: readonly (MessageContextReference | null)[]): Promise<(MessageContextCard | null)[]> {
    if (references.length > 50) throw new MessageFailure('MESSAGE_INVALID_LIMIT', 400, 'Message page exceeds limit');
    // Request-local only. New history reads always recheck canonical eligibility;
    // at most50 unique domain resolutions, in order, without parallel pool bursts.
    const current = new Map<string, MessageContextCard>();
    const result: (MessageContextCard | null)[] = [];
    for (const reference of references) {
      if (!reference) { result.push(null); continue; }
      const key = reference.type + ':' + reference.id.toLowerCase();
      let card = current.get(key);
      if (!card) { card = await this.resolve(actor, reference); current.set(key, card); }
      result.push(card);
    }
    return result;
  }
}

function prefix(text: string, limit: number): string { return [...text.trim()].slice(0, limit).join(''); }
