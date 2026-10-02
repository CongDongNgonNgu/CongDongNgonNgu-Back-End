import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CommunityModerationService,
  type CommunityModerationActor,
  type CommunityModerationNoteResponse,
  type CommunityModerationReportListResponse,
  type CommunityModerationReportResponse,
} from '../community/community.moderation.service';
import { COMMUNITY_REPOSITORY, type CommunityReportListQuery, type CommunityRepository } from '../community/community.repository';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type {
  IdentityAdminRepository,
  IdentityRepository,
  IdentityUserListQuery,
} from '../identity/identity.repository';
import type { RoleKey, UserRecord, UserStatus } from '../identity/identity.types';
import {
  evaluateRoleAssignment,
  hasCapability,
  ROLE_KEYS,
} from '../identity/role-policy';
import { RepositoryConflictError } from '../identity/identity.repository';
import {
  AdminModerationActionService,
  type AdminModerationActionResult,
  type AdminModerationActor,
  type AdminModerationContentAction,
  type AdminModerationContentTarget,
  type AdminModerationUserAction,
  type AdminReputationReversalResult,
} from './admin-moderation-action.service';
import { adminModerationFailure } from './admin-moderation.errors';
import {
  ADMIN_AUDIT_REPOSITORY,
  type AdminAuditEntry,
  type AdminAuditListQuery,
  type AdminAuditListResult,
  type AdminAuditRepository,
} from './admin-audit.repository';

export interface AdminActor {
  userId: string;
  roles: readonly RoleKey[];
}

export interface AdminUserResponse {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  roles: RoleKey[];
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserListResponse {
  items: AdminUserResponse[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminUserListInput {
  search?: string;
  status?: UserStatus;
  role?: RoleKey;
  limit?: number;
  offset?: number;
}

export interface AdminAuditInput extends Omit<AdminAuditListQuery, 'limit' | 'offset'> {
  limit?: number;
  offset?: number;
}

export interface AdminMetricsResponse {
  generatedAt: Date;
  users: {
    active: number;
    verificationPending: number;
    disabled: number;
    activeAdministrators: number;
  };
  moderation: {
    openReports: number;
    actionedReports: number;
    dismissedReports: number;
  };
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(IDENTITY_REPOSITORY)
    private readonly identities: IdentityRepository & IdentityAdminRepository,
    @Inject(COMMUNITY_REPOSITORY)
    private readonly community: CommunityRepository,
    private readonly moderationCases: CommunityModerationService,
    private readonly moderationActions: AdminModerationActionService,
    @Inject(ADMIN_AUDIT_REPOSITORY) private readonly audit: AdminAuditRepository,
  ) {}

  async metrics(actor: AdminActor): Promise<AdminMetricsResponse> {
    this.assertCapability(actor, 'VIEW_MODERATION_QUEUE');
    const [active, verificationPending, disabled, activeAdministrators, openReports, actionedReports, dismissedReports] = await Promise.all([
      this.identities.countUsers({ status: 'ACTIVE' }),
      this.identities.countUsers({ status: 'VERIFICATION_PENDING' }),
      this.identities.countUsers({ status: 'DISABLED' }),
      this.identities.countActiveAdministrators(),
      this.community.countReports({ state: 'OPEN' }),
      this.community.countReports({ state: 'ACTIONED' }),
      this.community.countReports({ state: 'DISMISSED' }),
    ]);
    return {
      generatedAt: new Date(),
      users: { active, verificationPending, disabled, activeAdministrators },
      moderation: { openReports, actionedReports, dismissedReports },
    };
  }

  listReports(
    actor: AdminActor,
    query: Omit<CommunityReportListQuery, 'limit'> & { limit?: number } = {},
  ): Promise<CommunityModerationReportListResponse> {
    return this.moderationCases.listReports(toCaseActor(actor), query);
  }

  getReport(actor: AdminActor, id: string): Promise<CommunityModerationReportResponse> {
    return this.moderationCases.getReport(toCaseActor(actor), id);
  }

  async assignReport(
    actor: AdminActor,
    id: string,
    assignedToUserId: string | null,
  ): Promise<CommunityModerationReportResponse> {
    const before = await this.moderationCases.getReport(toCaseActor(actor), id);
    const after = await this.moderationCases.assignReport(toCaseActor(actor), id, assignedToUserId);
    await this.writeAudit(actor, 'MODERATION_CASE_ASSIGN', 'MODERATION_CASE', id, 'Case assignment changed', before, after);
    return after;
  }

  async resolveReport(
    actor: AdminActor,
    id: string,
    state: 'OPEN' | 'DISMISSED' | 'ACTIONED',
    reason: string | null,
  ): Promise<CommunityModerationReportResponse> {
    const before = await this.moderationCases.getReport(toCaseActor(actor), id);
    const after = await this.moderationCases.resolveReport(toCaseActor(actor), id, state, reason);
    await this.writeAudit(actor, 'MODERATION_CASE_RESOLVE', 'MODERATION_CASE', id, after.resolutionReason ?? 'Case reopened', before, after);
    return after;
  }

  async addReportNote(
    actor: AdminActor,
    id: string,
    body: string,
  ): Promise<CommunityModerationNoteResponse> {
    const note = await this.moderationCases.addNote(toCaseActor(actor), id, body);
    await this.writeAudit(actor, 'MODERATION_CASE_NOTE', 'MODERATION_CASE', id, 'Moderation note added', null, note);
    return note;
  }

  listReportNotes(actor: AdminActor, id: string): Promise<CommunityModerationNoteResponse[]> {
    return this.moderationCases.listNotes(toCaseActor(actor), id);
  }

  async moderateContent(
    actor: AdminActor,
    input: {
      targetType: AdminModerationContentTarget;
      targetId: string;
      action: AdminModerationContentAction;
      reason: string;
    },
  ): Promise<AdminModerationActionResult> {
    const result = await this.moderationActions.moderateContent(toActionActor(actor), input);
    await this.writeAudit(actor, `CONTENT_${input.action}`, input.targetType, input.targetId, result.reason, {
      moderationState: result.previousState,
    }, {
      moderationState: result.nextState,
    });
    return result;
  }

  async moderateUser(
    actor: AdminActor,
    input: { targetUserId: string; action: AdminModerationUserAction; reason: string },
  ): Promise<AdminModerationActionResult> {
    const result = await this.moderationActions.moderateUser(toActionActor(actor), input);
    await this.writeAudit(actor, `USER_${input.action}`, 'USER', input.targetUserId, result.reason, {
      status: result.previousState,
    }, {
      status: result.nextState,
    });
    return result;
  }

  async reverseReputation(
    actor: AdminActor,
    input: { entryId: string; reason: string; idempotencyKey: string },
  ): Promise<AdminReputationReversalResult> {
    const result = await this.moderationActions.reverseReputation(toActionActor(actor), input);
    await this.writeAudit(actor, 'REPUTATION_REVERSE', 'REPUTATION_ENTRY', input.entryId, input.reason, null, result);
    return result;
  }

  async listUsers(actor: AdminActor, input: AdminUserListInput = {}): Promise<AdminUserListResponse> {
    this.assertCapability(actor, 'MANAGE_USERS');
    const limit = boundedLimit(input.limit);
    const offset = boundedOffset(input.offset);
    const result = await this.identities.listUsers({
      search: input.search?.trim() || undefined,
      status: input.status,
      role: input.role,
      limit,
      offset,
    });
    return {
      items: result.items.map(toAdminUser),
      total: result.total,
      limit,
      offset,
    };
  }

  async replaceRoles(
    actor: AdminActor,
    targetUserId: string,
    requestedRoles: readonly RoleKey[],
  ): Promise<AdminUserResponse> {
    this.assertCapability(actor, 'MANAGE_ROLES');
    const target = await this.identities.findUserById(targetUserId);
    if (!target) return adminModerationFailure('ADMIN_USER_NOT_FOUND', 'User is not available', 404);
    if (!requestedRoles.every((role) => ROLE_KEYS.includes(role))) {
      return adminModerationFailure('ADMIN_ROLE_ASSIGNMENT_REJECTED', 'Requested role is not supported', 400);
    }
    const decision = evaluateRoleAssignment({
      actorId: actor.userId,
      actorRoles: actor.roles,
      targetId: targetUserId,
      targetRoles: target.roles,
      requestedRoles,
      targetStatus: target.status,
      activeAdminCount: await this.identities.countActiveAdministrators(),
    });
    if (!decision.allowed) {
      const status = decision.reason === 'ACTOR_NOT_ADMIN' ? 403 : 409;
      return adminModerationFailure('ADMIN_ROLE_ASSIGNMENT_REJECTED', decision.reason, status);
    }
    let updated: UserRecord | null;
    try {
      updated = await this.identities.replaceUserRoles(targetUserId, decision.roles);
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        return adminModerationFailure('ADMIN_ROLE_ASSIGNMENT_REJECTED', error.message, 409);
      }
      throw error;
    }
    if (!updated) return adminModerationFailure('ADMIN_USER_NOT_FOUND', 'User is not available', 404);
    const response = toAdminUser(updated);
    await this.writeAudit(actor, 'USER_ROLES_REPLACE', 'USER', targetUserId, 'Platform roles changed', {
      roles: target.roles,
    }, {
      roles: response.roles,
    });
    return response;
  }

  async listAudit(actor: AdminActor, input: AdminAuditInput = {}): Promise<AdminAuditListResult> {
    this.assertCapability(actor, 'VIEW_AUDIT');
    return this.audit.list({
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      limit: boundedLimit(input.limit),
      offset: boundedOffset(input.offset),
    });
  }

  private async writeAudit(
    actor: AdminActor,
    action: string,
    targetType: string,
    targetId: string,
    reason: string,
    beforeState: unknown,
    afterState: unknown,
  ): Promise<AdminAuditEntry> {
    return this.audit.append({
      actorUserId: actor.userId,
      action,
      targetType,
      targetId,
      reason,
      correlationId: randomUUID(),
      beforeState: toAuditState(beforeState),
      afterState: toAuditState(afterState),
      metadata: null,
      createdAt: new Date(),
    });
  }

  private assertCapability(actor: AdminActor, capability: Parameters<typeof hasCapability>[1]): void {
    if (!hasCapability(actor.roles, capability)) {
      return adminModerationFailure('ADMIN_MODERATION_FORBIDDEN', 'You do not have permission for this action', 403);
    }
  }
}

function toCaseActor(actor: AdminActor): CommunityModerationActor {
  return { userId: actor.userId, roles: actor.roles };
}

function toActionActor(actor: AdminActor): AdminModerationActor {
  return { userId: actor.userId, roles: actor.roles };
}

function toAdminUser(user: UserRecord): AdminUserResponse {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    roles: [...user.roles],
    emailVerified: Boolean(user.emailVerifiedAt),
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
  };
}

function boundedLimit(value: number | undefined): number {
  return Math.min(Math.max(Math.trunc(value ?? 20), 1), 100);
}

function boundedOffset(value: number | undefined): number {
  return Math.min(Math.max(Math.trunc(value ?? 0), 0), 100_000);
}

function toAuditState(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}
