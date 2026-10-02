import { Injectable } from '@nestjs/common';
import type { RoleCapability } from '../identity/role-policy';
import { hasCapability } from '../identity/role-policy';
import type { RoleKey } from '../identity/identity.types';
import { communityFailure } from './community.errors';
import {
  COMMUNITY_REPOSITORY,
  type CommunityReportListQuery,
  type CommunityRepository,
  type UpdateCommunityReportInput,
} from './community.repository';
import { Inject } from '@nestjs/common';
import type {
  CommunityReportNoteRecord,
  CommunityReportRecord,
  CommunityReportState,
} from './community.types';
import { normalizeCommunityContent } from './community.normalization';

const DEFAULT_QUEUE_LIMIT = 20;
const MAX_QUEUE_LIMIT = 50;
const MAX_NOTE_LENGTH = 2_000;
const MAX_REASON_LENGTH = 1_000;

export interface CommunityModerationActor {
  userId: string;
  roles: readonly RoleKey[];
}

export interface CommunityModerationReportResponse {
  id: string;
  targetType: CommunityReportRecord['targetType'];
  targetId: string;
  category: CommunityReportRecord['category'];
  details: string | null;
  state: CommunityReportState;
  assignedToUserId: string | null;
  resolutionReason: string | null;
  duplicateGroupKey: string;
  duplicateCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommunityModerationReportListResponse {
  items: CommunityModerationReportResponse[];
  hasMore: boolean;
}

export interface CommunityModerationNoteResponse extends CommunityReportNoteRecord {}

@Injectable()
export class CommunityModerationService {
  constructor(
    @Inject(COMMUNITY_REPOSITORY) private readonly repository: CommunityRepository,
  ) {}

  async listReports(
    actor: CommunityModerationActor,
    query: Omit<CommunityReportListQuery, 'limit'> & { limit?: number } = {},
  ): Promise<CommunityModerationReportListResponse> {
    this.assertCapability(actor, 'VIEW_MODERATION_QUEUE');
    const page = await this.repository.listReports({
      ...query,
      limit: normalizeLimit(query.limit),
    });
    return {
      items: page.items.map(toSafeReport),
      hasMore: page.hasMore,
    };
  }

  async getReport(
    actor: CommunityModerationActor,
    id: string,
  ): Promise<CommunityModerationReportResponse> {
    this.assertCapability(actor, 'VIEW_MODERATION_QUEUE');
    const report = await this.repository.findReportById(id);
    if (!report) return communityFailure('COMMUNITY_MODERATION_CASE_NOT_FOUND', 'Moderation case is not available', 404);
    return toSafeReport(report);
  }

  async assignReport(
    actor: CommunityModerationActor,
    id: string,
    assignedToUserId: string | null,
  ): Promise<CommunityModerationReportResponse> {
    this.assertCapability(actor, 'ASSIGN_MODERATION_CASE');
    const report = await this.repository.findReportById(id);
    if (!report) return communityFailure('COMMUNITY_MODERATION_CASE_NOT_FOUND', 'Moderation case is not available', 404);
    const updated = await this.repository.updateReport(id, {
      assignedToUserId,
      updatedAt: new Date(),
    });
    if (!updated) return communityFailure('COMMUNITY_MODERATION_CASE_NOT_FOUND', 'Moderation case is not available', 404);
    return toSafeReport(updated);
  }

  async resolveReport(
    actor: CommunityModerationActor,
    id: string,
    state: CommunityReportState,
    reason: string | null,
  ): Promise<CommunityModerationReportResponse> {
    this.assertCapability(actor, 'MODERATE_CONTENT');
    const report = await this.repository.findReportById(id);
    if (!report) return communityFailure('COMMUNITY_MODERATION_CASE_NOT_FOUND', 'Moderation case is not available', 404);
    const normalizedReason = reason === null ? null : normalizeBoundedReason(reason);
    if ((state === 'ACTIONED' || state === 'DISMISSED') && !normalizedReason) {
      return communityFailure('COMMUNITY_MODERATION_REASON_REQUIRED', 'A reason is required for this outcome', 400);
    }
    const input: UpdateCommunityReportInput = {
      state,
      resolutionReason: normalizedReason,
      updatedAt: new Date(),
    };
    const updated = await this.repository.updateReport(id, input);
    if (!updated) return communityFailure('COMMUNITY_MODERATION_CASE_NOT_FOUND', 'Moderation case is not available', 404);
    return toSafeReport(updated);
  }

  async addNote(
    actor: CommunityModerationActor,
    id: string,
    body: string,
  ): Promise<CommunityModerationNoteResponse> {
    this.assertCapability(actor, 'MODERATE_CONTENT');
    const report = await this.repository.findReportById(id);
    if (!report) return communityFailure('COMMUNITY_MODERATION_CASE_NOT_FOUND', 'Moderation case is not available', 404);
    const normalizedBody = normalizeCommunityContent(body, MAX_NOTE_LENGTH);
    return this.repository.addReportNote(id, actor.userId, normalizedBody, new Date());
  }

  async listNotes(
    actor: CommunityModerationActor,
    id: string,
  ): Promise<CommunityModerationNoteResponse[]> {
    this.assertCapability(actor, 'VIEW_MODERATION_QUEUE');
    const report = await this.repository.findReportById(id);
    if (!report) return communityFailure('COMMUNITY_MODERATION_CASE_NOT_FOUND', 'Moderation case is not available', 404);
    return this.repository.listReportNotes(id);
  }

  private assertCapability(actor: CommunityModerationActor, capability: RoleCapability): void {
    if (!hasCapability(actor.roles, capability)) {
      return communityFailure('COMMUNITY_MODERATION_FORBIDDEN', 'You do not have moderation access', 403);
    }
  }
}

function normalizeLimit(value: number | undefined): number {
  if (!value || !Number.isInteger(value)) return DEFAULT_QUEUE_LIMIT;
  return Math.min(Math.max(value, 1), MAX_QUEUE_LIMIT);
}

function normalizeBoundedReason(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return communityFailure('COMMUNITY_MODERATION_REASON_REQUIRED', 'A reason is required for this outcome', 400);
  }
  const normalized = normalizeCommunityContent(value, MAX_REASON_LENGTH);
  return normalized;
}

function toSafeReport(report: CommunityReportRecord): CommunityModerationReportResponse {
  return {
    id: report.id,
    targetType: report.targetType,
    targetId: report.targetId,
    category: report.category,
    details: report.details,
    state: report.state,
    assignedToUserId: report.assignedToUserId,
    resolutionReason: report.resolutionReason,
    duplicateGroupKey: report.duplicateGroupKey,
    duplicateCount: report.duplicateCount,
    createdAt: new Date(report.createdAt),
    updatedAt: new Date(report.updatedAt),
  };
}
