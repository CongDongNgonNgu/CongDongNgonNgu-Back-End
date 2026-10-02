import { describe, expect, it, jest } from '@jest/globals';
import type { AuthenticatedRequest } from '../auth/guards/access-token.guard';
import type { SessionService } from '../auth/session/session.service';
import type { UserRecord } from '../identity/identity.types';
import { AdminController } from './admin.controller';
import type { AdminMetricsResponse, AdminService } from './admin.service';
import type { AdminModerationActionResult } from './admin-moderation-action.service';

describe('AdminController', () => {
  it('maps the authenticated UserRecord to the backend actor for metrics', async () => {
    const metrics: AdminMetricsResponse = {
      generatedAt: new Date('2026-10-02T05:00:00.000Z'),
      users: { active: 1, verificationPending: 0, disabled: 0, activeAdministrators: 1 },
      moderation: { openReports: 0, actionedReports: 0, dismissedReports: 0 },
    };
    const admin = { metrics: jest.fn<AdminService['metrics']>().mockResolvedValue(metrics) } as unknown as AdminService;
    const controller = new AdminController(admin, {} as SessionService);
    const user = userRecord('admin-1', ['ADMIN']);

    await controller.metrics(user);

    expect(admin.metrics).toHaveBeenCalledWith({ userId: 'admin-1', roles: ['ADMIN'] });
  });

  it('enforces the controller CSRF boundary and forwards the real actor id for content actions', async () => {
    const action: AdminModerationActionResult = {
        targetType: 'COMMUNITY_POST',
        targetId: 'post-1',
        action: 'HIDE',
        previousState: 'ACTIVE',
        nextState: 'HIDDEN',
        reason: 'Policy violation',
        changed: true,
    };
    const admin = {
      moderateContent: jest.fn<AdminService['moderateContent']>().mockResolvedValue(action),
    } as unknown as AdminService;
    const sessions = { assertCsrfForCookie: jest.fn() } as unknown as SessionService;
    const controller = new AdminController(admin, sessions);
    const user = userRecord('moderator-1', ['MODERATOR']);
    const request = { headers: {} } as AuthenticatedRequest;

    await controller.moderateContent(
      'COMMUNITY_POST',
      'post-1',
      { action: 'HIDE', reason: 'Policy violation' },
      request,
      user,
    );

    expect(sessions.assertCsrfForCookie).toHaveBeenCalledWith(request);
    expect(admin.moderateContent).toHaveBeenCalledWith(
      { userId: 'moderator-1', roles: ['MODERATOR'] },
      {
        targetType: 'COMMUNITY_POST',
        targetId: 'post-1',
        action: 'HIDE',
        reason: 'Policy violation',
      },
    );
  });
});

function userRecord(id: string, roles: UserRecord['roles']): UserRecord {
  const now = new Date('2026-10-02T05:00:00.000Z');
  return {
    id,
    email: `${id}@example.com`,
    displayName: id,
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
    roles,
  };
}
