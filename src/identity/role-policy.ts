import type { RoleKey, UserStatus } from './identity.types';

export const ROLE_KEYS: readonly RoleKey[] = [
  'USER',
  'CONTRIBUTOR',
  'EXPERT',
  'MEMBER',
  'MODERATOR',
  'ADMIN',
];

export type RoleCapability =
  | 'VIEW_MODERATION_QUEUE'
  | 'ASSIGN_MODERATION_CASE'
  | 'MODERATE_CONTENT'
  | 'MANAGE_USERS'
  | 'MANAGE_ROLES'
  | 'VIEW_AUDIT'
  | 'VIEW_BILLING'
  | 'VIEW_AI_OPERATIONS'
  | 'MANAGE_REPUTATION';

export const MODERATOR_CAPABILITIES: readonly RoleCapability[] = [
  'VIEW_MODERATION_QUEUE',
  'ASSIGN_MODERATION_CASE',
  'MODERATE_CONTENT',
];

export const ADMIN_CAPABILITIES: readonly RoleCapability[] = [
  ...MODERATOR_CAPABILITIES,
  'MANAGE_USERS',
  'MANAGE_ROLES',
  'VIEW_AUDIT',
  'VIEW_BILLING',
  'VIEW_AI_OPERATIONS',
  'MANAGE_REPUTATION',
];

const ROLE_CAPABILITIES: Readonly<Record<RoleKey, readonly RoleCapability[]>> = {
  USER: [],
  CONTRIBUTOR: [],
  EXPERT: [],
  MEMBER: [],
  MODERATOR: MODERATOR_CAPABILITIES,
  ADMIN: ADMIN_CAPABILITIES,
};

export function hasCapability(
  roles: readonly RoleKey[],
  capability: RoleCapability,
): boolean {
  return roles.some((role) => ROLE_CAPABILITIES[role]?.includes(capability));
}

export function capabilitiesForRoles(roles: readonly RoleKey[]): RoleCapability[] {
  return [...new Set(roles.flatMap((role) => ROLE_CAPABILITIES[role] ?? []))];
}

export type RoleAssignmentRejection =
  | 'ACTOR_NOT_ADMIN'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_DISABLED'
  | 'LAST_ADMIN'
  | 'EMPTY_ROLE_SET';

export type RoleAssignmentDecision =
  | { allowed: true; roles: RoleKey[] }
  | { allowed: false; reason: RoleAssignmentRejection };

export interface RoleAssignmentInput {
  actorId: string;
  actorRoles: readonly RoleKey[];
  targetId: string;
  targetRoles: readonly RoleKey[];
  requestedRoles: readonly RoleKey[];
  targetStatus: UserStatus;
  activeAdminCount: number;
}

export function evaluateRoleAssignment(input: RoleAssignmentInput): RoleAssignmentDecision {
  if (!hasCapability(input.actorRoles, 'MANAGE_ROLES')) {
    return { allowed: false, reason: 'ACTOR_NOT_ADMIN' };
  }
  if (input.targetStatus === 'DISABLED' && input.requestedRoles.some(isPrivilegedRole)) {
    return { allowed: false, reason: 'TARGET_DISABLED' };
  }

  const requestedRoles = uniqueRoles(input.requestedRoles);
  if (requestedRoles.length === 0) {
    return { allowed: false, reason: 'EMPTY_ROLE_SET' };
  }

  const removesAdmin = input.targetRoles.includes('ADMIN') && !requestedRoles.includes('ADMIN');
  if (removesAdmin && input.activeAdminCount <= 1) {
    return { allowed: false, reason: 'LAST_ADMIN' };
  }

  return { allowed: true, roles: requestedRoles };
}

export function uniqueRoles(roles: readonly RoleKey[]): RoleKey[] {
  return [...new Set(roles)];
}

function isPrivilegedRole(role: RoleKey): boolean {
  return role === 'MODERATOR' || role === 'ADMIN';
}
