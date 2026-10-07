import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import {
  PROFILE_REPOSITORY,
  type ProfileRepository,
} from '../profile/profile.repository';
import { COMMUNITY_CEFR_LEVELS } from '../community/community.types';
import { LibraryService } from './library.service';
import {
  LIBRARY_REPOSITORY,
  type LibraryRepository,
} from './library.repository';
import {
  LIBRARY_RELATIONS_REPOSITORY,
  type LibraryRelationsRepository,
} from './library-relations.repository';
import {
  LIBRARY_RELATION_TYPES,
  type LibraryRelationRecord,
  type LibraryRelationReviewInput,
  type LibraryRelatedInput,
  type LibraryRelatedPage,
} from './library-relations.types';
import {
  LIBRARY_RESOURCE_TYPES,
  type LibraryPublicResource,
} from './library.types';
import { libraryFailure } from './library.errors';
import { LibraryRelatedCursor } from './library-relations.cursor';

@Injectable()
export class LibraryRelationsService {
  private readonly cursor: LibraryRelatedCursor;
  constructor(
    private readonly library: LibraryService,
    @Inject(LIBRARY_REPOSITORY) private readonly resources: LibraryRepository,
    @Inject(LIBRARY_RELATIONS_REPOSITORY)
    private readonly relations: LibraryRelationsRepository,
    @Inject(IDENTITY_REPOSITORY) private readonly identity: IdentityRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    config: ConfigService,
  ) {
    this.cursor = new LibraryRelatedCursor(
      config.get<string>('auth.accessSecret') ?? '',
    );
  }

  // Trusted internal entry point; never exposed by a public mutation route.
  async review(
    reviewerUserId: string,
    input: LibraryRelationReviewInput,
  ): Promise<LibraryRelationRecord> {
    if (!(await this.authorized(reviewerUserId)))
      libraryFailure(
        'LIBRARY_REVIEW_FORBIDDEN',
        'An authorized reviewer is required',
        403,
      );
    if (
      !uuid(input.anchorId) ||
      !uuid(input.targetId) ||
      input.anchorId === input.targetId ||
      !LIBRARY_RELATION_TYPES.includes(input.type) ||
      typeof input.evidenceReference !== 'string' ||
      !input.evidenceReference.trim() ||
      input.evidenceReference !== input.evidenceReference.trim() ||
      input.evidenceReference.length > 500
    )
      libraryFailure(
        'LIBRARY_RELATION_INVALID',
        'The reviewed relation is invalid',
      );
    const endpoints = await this.library.projectRelatedResources(
      await this.resources.findResourcesByIds([input.anchorId, input.targetId]),
    );
    const anchor = endpoints.get(input.anchorId),
      target = endpoints.get(input.targetId);
    if (
      !anchor ||
      !target ||
      !shape(input.type, anchor.resource, target.resource)
    )
      libraryFailure(
        'LIBRARY_RELATION_INELIGIBLE',
        'The reviewed relation endpoints are unavailable',
        409,
      );
    // Explicit re-review replaces snapshots and advances revision; reads never do.
    return this.relations.review({
      ...input,
      reviewerUserId,
      reviewedAt: new Date(),
      anchorSnapshot: anchor.snapshot,
      targetSnapshot: target.snapshot,
    });
  }
  async revoke(
    reviewerUserId: string,
    input: Pick<LibraryRelationReviewInput, 'anchorId' | 'targetId' | 'type'>,
  ): Promise<void> {
    if (!(await this.authorized(reviewerUserId)))
      libraryFailure(
        'LIBRARY_REVIEW_FORBIDDEN',
        'An authorized reviewer is required',
        403,
      );
    if (
      !uuid(input.anchorId) ||
      !uuid(input.targetId) ||
      !LIBRARY_RELATION_TYPES.includes(input.type)
    )
      libraryFailure(
        'LIBRARY_RELATION_INVALID',
        'The reviewed relation is invalid',
      );
    await this.relations.revoke(input.anchorId, input.targetId, input.type);
  }

  async list(
    anchorId: string,
    input: LibraryRelatedInput,
  ): Promise<LibraryRelatedPage> {
    anchorId = anchorId.toLowerCase();
    const filters = normalize(input),
      binding = JSON.stringify({ v: 1, anchorId, ...filters });
    const after = this.cursor.decode(input.cursor, binding);
    if (
      filters.language &&
      (await this.profiles.findActiveByCodes([filters.language])).length !== 1
    )
      libraryFailure(
        'LIBRARY_LANGUAGE_UNAVAILABLE',
        'The library language is unavailable',
      );
    const selectedAnchor = await this.library.projectRelatedResources(
      await this.resources.findResourcesByIds([anchorId]),
    );
    const anchor = selectedAnchor.get(anchorId);
    if (!anchor) return notFound();
    const page = await this.relations.scan(anchorId, after, filters.relation);
    const targets = page.targets;
    const projected = await this.library.projectRelatedResources(
      await this.resources.findResourcesByIds(targets),
    );
    const authority = await this.authorities(
      page.assertions.map((r) => r.reviewerUserId),
    );
    const prepared: LibraryRelationRecord[] = [];
    let boundary = after,
      consumed = 0;
    for (const targetId of targets) {
      boundary = targetId;
      consumed++;
      const target = projected.get(targetId);
      if (target && matches(target.resource, filters)) {
        const relation = page.assertions.find(
          (r) =>
            r.targetId === targetId &&
            valid(r, anchor.snapshot, target.snapshot, authority) &&
            shape(r.type, anchor.resource, target.resource),
        );
        if (relation) prepared.push(relation);
      }
      if (prepared.length === filters.limit) break;
    }
    // Re-read current facts, reviewer authority and assertion revisions at final
    // projection. Ordinary reads do not claim atomic/distributed revocation.
    const finalProjected = await this.library.projectRelatedResources(
      await this.resources.findResourcesByIds([
        anchorId,
        ...prepared.map((r) => r.targetId),
      ]),
    );
    const finalAnchor = finalProjected.get(anchorId);
    if (!finalAnchor || finalAnchor.snapshot !== anchor.snapshot)
      return notFound();
    const currentRelations = await this.relations.findForTargets(
      anchorId,
      prepared.map((r) => r.targetId),
    );
    const finalAuthority = await this.authorities(
      prepared.map((r) => r.reviewerUserId),
    );
    const items: LibraryRelatedPage['items'] = [];
    for (const relation of prepared) {
      const target = finalProjected.get(relation.targetId);
      const current = currentRelations.find(
        (r) => r.targetId === relation.targetId && r.type === relation.type,
      );
      if (
        target &&
        current &&
        sameAssertion(relation, current) &&
        valid(current, finalAnchor.snapshot, target.snapshot, finalAuthority) &&
        matches(target.resource, filters) &&
        shape(current.type, finalAnchor.resource, target.resource)
      )
        items.push({
          resource: target.resource,
          relation: { type: current.type },
        });
    }
    return {
      items,
      nextCursor:
        boundary && (consumed < targets.length || page.hasMore)
          ? this.cursor.encode(boundary, binding)
          : null,
    };
  }
  private async authorities(
    ids: readonly string[],
  ): Promise<Map<string, boolean>> {
    if (this.identity.findUsersByIds) {
      const users = await this.identity.findUsersByIds([...new Set(ids)]);
      return new Map(
        users.map((user) => [
          user.id,
          user.status === 'ACTIVE' &&
            (user.roles.includes('MODERATOR') || user.roles.includes('ADMIN')),
        ]),
      );
    }
    return new Map(
      await Promise.all(
        [...new Set(ids)].map(
          async (id) => [id, await this.authorized(id)] as const,
        ),
      ),
    );
  }
  private async authorized(id: string) {
    const user = await this.identity.findUserById(id);
    return Boolean(
      user &&
      user.status === 'ACTIVE' &&
      (user.roles.includes('MODERATOR') || user.roles.includes('ADMIN')),
    );
  }
}
function notFound(): never {
  libraryFailure(
    'LIBRARY_RESOURCE_NOT_FOUND',
    'The public library resource was not found',
    404,
  );
}
function uuid(input: unknown): input is string {
  return (
    typeof input === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input,
    )
  );
}
function normalize(input: LibraryRelatedInput) {
  const bad = () =>
    libraryFailure(
      'LIBRARY_RELATED_INPUT_INVALID',
      'Library related input is invalid',
    );
  if (
    !input ||
    Object.keys(input).some(
      (key) =>
        !['relation', 'language', 'type', 'level', 'cursor', 'limit'].includes(
          key,
        ),
    )
  )
    bad();
  const relation =
    input.relation === undefined
      ? null
      : (LIBRARY_RELATION_TYPES.find((v) => v === input.relation) ?? bad());
  const type =
    input.type === undefined
      ? null
      : (LIBRARY_RESOURCE_TYPES.find((v) => v === input.type) ?? bad());
  const level =
    input.level === undefined
      ? null
      : (COMMUNITY_CEFR_LEVELS.find((v) => v === input.level) ?? bad());
  let language: string | null = null;
  if (input.language !== undefined) {
    if (
      typeof input.language !== 'string' ||
      input.language.length > 35 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(input.language)
    )
      bad();
    language = (input.language as string).toLowerCase();
  }
  const limit =
    input.limit === undefined
      ? 3
      : typeof input.limit === 'number'
        ? input.limit
        : typeof input.limit === 'string' && /^[0-9]+$/.test(input.limit)
          ? Number(input.limit)
          : bad();
  if (!Number.isInteger(limit) || limit < 1 || limit > 12) bad();
  return { relation, type, level, language, limit };
}
function matches(
  resource: LibraryPublicResource,
  f: ReturnType<typeof normalize>,
) {
  return (
    (!f.language ||
      resource.primaryLanguageCode === f.language ||
      resource.secondaryLanguageCode === f.language) &&
    (!f.type || resource.resourceType === f.type) &&
    (!f.level || resource.cefrLevel === f.level)
  );
}
function valid(
  r: LibraryRelationRecord,
  anchor: string,
  target: string,
  authority: ReadonlyMap<string, boolean>,
) {
  return (
    r.status === 'ACTIVE' &&
    r.revision > 0 &&
    r.anchorSnapshot === anchor &&
    r.targetSnapshot === target &&
    authority.get(r.reviewerUserId) === true &&
    !!r.evidenceReference.trim() &&
    r.evidenceReference.length <= 500 &&
    Number.isFinite(r.reviewedAt.getTime())
  );
}
function sameAssertion(a: LibraryRelationRecord, b: LibraryRelationRecord) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function shape(
  type: LibraryRelationRecord['type'],
  anchor: LibraryPublicResource,
  target: LibraryPublicResource,
) {
  if (anchor.id === target.id) return false;
  if (type === 'COLLECTION_MEMBER')
    return anchor.resourceType === 'LEARNING_COLLECTION';
  if (type !== 'DIRECT_TRANSLATION') return true;
  const text =
    anchor.details.resourceType === 'VOCABULARY'
      ? anchor.details.term
      : anchor.details.resourceType === 'SENTENCE'
        ? anchor.details.text
        : anchor.details.resourceType === 'TRANSLATION'
          ? anchor.details.sourceText
          : null;
  return (
    text !== null &&
    target.details.resourceType === 'TRANSLATION' &&
    target.details.sourceText === text &&
    target.primaryLanguageCode === anchor.primaryLanguageCode &&
    target.secondaryLanguageCode !== null &&
    target.secondaryLanguageCode !== target.primaryLanguageCode
  );
}
