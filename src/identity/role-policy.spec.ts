import { describe, expect, it } from '@jest/globals';
import {
  ADMIN_CAPABILITIES,
  evaluateRoleAssignment,
  hasCapability,
} from './role-policy';

describe('role policy', () => {
  it('keeps expertise roles separate from platform administration', () => {
    expect(hasCapability(['EXPERT'], 'MODERATE_CONTENT')).toBe(false);
    expect(hasCapability(['CONTRIBUTOR'], 'MANAGE_ROLES')).toBe(false);
    expect(hasCapability(['MODERATOR'], 'MODERATE_CONTENT')).toBe(true);
    expect(hasCapability(['MODERATOR'], 'MANAGE_ROLES')).toBe(false);
    expect(hasCapability(['ADMIN'], 'MANAGE_ROLES')).toBe(true);
    expect(ADMIN_CAPABILITIES).toContain('VIEW_AUDIT');
  });

  it('rejects role escalation by non-admin actors', () => {
    const decision = evaluateRoleAssignment({
      actorId: 'member',
      actorRoles: ['MEMBER'],
      targetId: 'member-2',
      targetRoles: ['MEMBER'],
      requestedRoles: ['MODERATOR'],
      targetStatus: 'ACTIVE',
      activeAdminCount: 2,
    });

    expect(decision).toEqual({
      allowed: false,
      reason: 'ACTOR_NOT_ADMIN',
    });
  });

  it('protects the last active administrator from self-demotion or removal', () => {
    const selfDecision = evaluateRoleAssignment({
      actorId: 'admin-1',
      actorRoles: ['ADMIN'],
      targetId: 'admin-1',
      targetRoles: ['ADMIN'],
      requestedRoles: ['USER'],
      targetStatus: 'ACTIVE',
      activeAdminCount: 1,
    });
    const otherDecision = evaluateRoleAssignment({
      actorId: 'admin-2',
      actorRoles: ['ADMIN'],
      targetId: 'admin-1',
      targetRoles: ['ADMIN'],
      requestedRoles: ['USER'],
      targetStatus: 'ACTIVE',
      activeAdminCount: 1,
    });

    expect(selfDecision).toEqual({ allowed: false, reason: 'LAST_ADMIN' });
    expect(otherDecision).toEqual({ allowed: false, reason: 'LAST_ADMIN' });
  });

  it('does not grant privileged roles to disabled accounts', () => {
    const decision = evaluateRoleAssignment({
      actorId: 'admin-1',
      actorRoles: ['ADMIN'],
      targetId: 'user-2',
      targetRoles: ['USER'],
      requestedRoles: ['MODERATOR'],
      targetStatus: 'DISABLED',
      activeAdminCount: 2,
    });

    expect(decision).toEqual({ allowed: false, reason: 'TARGET_DISABLED' });
  });
});
