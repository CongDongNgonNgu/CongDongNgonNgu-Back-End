import { Inject, Injectable } from '@nestjs/common';
import { COMMUNITY_REPOSITORY, type CommunityRepository } from '../community/community.repository';
import type { CommunityModerationState } from '../community/community.types';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import type { RoleKey } from '../identity/identity.types';
import { hasCapability } from '../identity/role-policy';
import { LIBRARY_REPOSITORY, type LibraryRepository } from '../library/library.repository';
import { REPUTATION_SERVICE, ReputationService } from '../reputation/reputation.service';
import { adminModerationFailure } from './admin-moderation.errors';

const MAX_REASON_LENGTH = 1_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export type AdminModerationContentTarget =
  | 'COMMUNITY_POST'
  | 'COMMUNITY_COMMENT'
  | 'LIBRARY_RESOURCE';

export type AdminModerationContentAction = 'HIDE' | 'REMOVE' | 'RESTORE';
export type AdminModerationUserAction = 'WARN' | 'SUSPEND' | 'RESTORE';

export interface AdminModerationActor {
  userId: string;
  roles: readonly RoleKey[];
}

export interface ModerateContentInput {
  targetType: AdminModerationContentTarget;
  targetId: string;
  action: AdminModerationContentAction;
  reason: string;
}

export interface ModerateUserInput {
  targetUserId: string;
  action: AdminModerationUserAction;
  reason: string;
}

export interface ReverseReputationInput {
  entryId: string;
  reason: string;
  idempotencyKey: string;
}

export interface AdminModerationActionResult {
  targetType: AdminModerationContentTarget | 'USER';
  targetId: string;
  action: AdminModerationContentAction | AdminModerationUserAction;
  previousState: string | null;
  nextState: string | null;
  reason: string;
  changed: boolean;
}

export interface AdminReputationReversalResult {
  entryId: string;
  originalEntryId: string;
  delta: number;
  created: boolean;
}

@Injectable()
export class AdminModerationActionService {
  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    @Inject(COMMUNITY_REPOSITORY) private readonly community: CommunityRepository,
    @Inject(LIBRARY_REPOSITORY) private readonly library: LibraryRepository,
    @Inject(REPUTATION_SERVICE) private readonly reputation: ReputationService,
  ) {}

  async moderateContent(
    actor: AdminModerationActor,
    input: ModerateContentInput,
  ): Promise<AdminModerationActionResult> {
    this.assertCapability(actor, 'MODERATE_CONTENT');
    const reason = normalizeReason(input.reason);
    const nextState = moderationStateForAction(input.action);
    const now = new Date();

    if (input.targetType === 'COMMUNITY_POST') {
      const current = await this.community.findPostById(input.targetId);
      if (!current) return adminModerationFailure('ADMIN_MODERATION_TARGET_NOT_FOUND', 'Content target is not available', 404);
      if (current.moderationState === nextState) {
        return actionResult(input.targetType, input.targetId, input.action, current.moderationState, nextState, reason, false);
      }
      const updated = input.action === 'REMOVE'
        ? await this.community.softDeletePost(input.targetId, actor.userId, now)
        : await this.community.setPostModerationState(input.targetId, nextState, now);
      if (!updated) return adminModerationFailure('ADMIN_MODERATION_TARGET_NOT_FOUND', 'Content target is not available', 404);
      return actionResult(input.targetType, input.targetId, input.action, current.moderationState, updated.moderationState, reason, true);
    }

    if (input.targetType === 'COMMUNITY_COMMENT') {
      const current = await this.community.findCommentById(input.targetId);
      if (!current) return adminModerationFailure('ADMIN_MODERATION_TARGET_NOT_FOUND', 'Content target is not available', 404);
      if (current.moderationState === nextState) {
        return actionResult(input.targetType, input.targetId, input.action, current.moderationState, nextState, reason, false);
      }
      const updated = input.action === 'REMOVE'
        ? await this.community.softDeleteComment(input.targetId, actor.userId, now)
        : await this.community.setCommentModerationState(input.targetId, nextState, now);
      if (!updated) return adminModerationFailure('ADMIN_MODERATION_TARGET_NOT_FOUND', 'Content target is not available', 404);
      return actionResult(input.targetType, input.targetId, input.action, current.moderationState, updated.moderationState, reason, true);
    }

    const current = await this.library.findResourceById(input.targetId);
    if (!current) return adminModerationFailure('ADMIN_MODERATION_TARGET_NOT_FOUND', 'Content target is not available', 404);
    if (current.moderationState === nextState) {
      return actionResult(input.targetType, input.targetId, input.action, current.moderationState, nextState, reason, false);
    }
    const updated = await this.library.setModerationState(input.targetId, nextState, now);
    if (!updated) return adminModerationFailure('ADMIN_MODERATION_TARGET_NOT_FOUND', 'Content target is not available', 404);
    return actionResult(input.targetType, input.targetId, input.action, current.moderationState, updated.moderationState, reason, true);
  }

  async moderateUser(
    actor: AdminModerationActor,
    input: ModerateUserInput,
  ): Promise<AdminModerationActionResult> {
    this.assertCapability(actor, 'MANAGE_USERS');
    const reason = normalizeReason(input.reason);
    const current = await this.identities.findUserById(input.targetUserId);
    if (!current) return adminModerationFailure('ADMIN_MODERATION_TARGET_NOT_FOUND', 'User target is not available', 404);

    if (input.action === 'WARN') {
      return actionResult('USER', input.targetUserId, input.action, current.status, current.status, reason, false);
    }

    const nextState = input.action === 'SUSPEND' ? 'DISABLED' : 'ACTIVE';
    if (current.status === nextState) {
      return actionResult('USER', input.targetUserId, input.action, current.status, nextState, reason, false);
    }
    const updated = await this.identities.updateUser(input.targetUserId, { status: nextState });
    if (!updated) return adminModerationFailure('ADMIN_MODERATION_TARGET_NOT_FOUND', 'User target is not available', 404);
    return actionResult('USER', input.targetUserId, input.action, current.status, updated.status, reason, true);
  }

  async reverseReputation(
    actor: AdminModerationActor,
    input: ReverseReputationInput,
  ): Promise<AdminReputationReversalResult> {
    this.assertCapability(actor, 'MANAGE_REPUTATION');
    const reason = normalizeReason(input.reason);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const result = await this.reputation.reverseEntry({
      entryId: input.entryId,
      reason,
      idempotencyKey,
      createdAt: new Date(),
    });
    return {
      entryId: result.entry.id,
      originalEntryId: result.entry.reversalOfEntryId!,
      delta: result.entry.delta,
      created: result.created,
    };
  }

  private assertCapability(actor: AdminModerationActor, capability: Parameters<typeof hasCapability>[1]): void {
    if (!hasCapability(actor.roles, capability)) {
      return adminModerationFailure('ADMIN_MODERATION_FORBIDDEN', 'You do not have permission for this action', 403);
    }
  }
}

function moderationStateForAction(action: AdminModerationContentAction): CommunityModerationState {
  if (action === 'HIDE') return 'HIDDEN';
  if (action === 'REMOVE') return 'DELETED';
  return 'ACTIVE';
}

function normalizeReason(value: string): string {
  if (typeof value !== 'string') return adminModerationFailure('ADMIN_MODERATION_REASON_REQUIRED', 'A reason is required', 400);
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized || normalized.length > MAX_REASON_LENGTH) {
    return adminModerationFailure('ADMIN_MODERATION_REASON_REQUIRED', 'A bounded reason is required', 400);
  }
  return normalized;
}

function normalizeIdempotencyKey(value: string): string {
  if (typeof value !== 'string') return adminModerationFailure('ADMIN_MODERATION_IDEMPOTENCY_INVALID', 'A bounded idempotency key is required', 400);
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return adminModerationFailure('ADMIN_MODERATION_IDEMPOTENCY_INVALID', 'A bounded idempotency key is required', 400);
  }
  return normalized;
}

function actionResult(
  targetType: AdminModerationActionResult['targetType'],
  targetId: string,
  action: AdminModerationActionResult['action'],
  previousState: string,
  nextState: string,
  reason: string,
  changed: boolean,
): AdminModerationActionResult {
  return { targetType, targetId, action, previousState, nextState, reason, changed };
}
