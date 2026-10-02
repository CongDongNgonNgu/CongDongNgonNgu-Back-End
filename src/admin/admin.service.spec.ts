import { describe, expect, it } from '@jest/globals';
import { InMemoryCommunityRepository } from '../community/community.repository';
import { CommunityModerationService } from '../community/community.moderation.service';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { InMemoryLibraryRepository } from '../library/library.repository';
import { InMemoryReputationLedgerRepository } from '../reputation/reputation.repository';
import { AntiFarmingRuleEngine } from '../reputation/anti-farming.rules';
import { ContributionRuleEngine } from '../reputation/reputation.rules';
import { ReputationService } from '../reputation/reputation.service';
import { AdminModerationActionService } from './admin-moderation-action.service';
import { AdminService } from './admin.service';
import { InMemoryAdminAuditRepository } from './admin-audit.repository';

describe('AdminService', () => {
  it('orchestrates reporter-redacted cases and records assignment/transition audits', async () => {
    const identities = new InMemoryIdentityRepository();
    const community = new InMemoryCommunityRepository();
    const library = new InMemoryLibraryRepository();
    const reputation = new ReputationService(
      new InMemoryReputationLedgerRepository(),
      new ContributionRuleEngine(),
      new AntiFarmingRuleEngine(),
    );
    const audit = new InMemoryAdminAuditRepository();
    const service = createService(identities, community, library, reputation, audit);
    const moderatorUser = (await createUser(identities, 'moderator@example.com', 'Moderator', ['MODERATOR']))!;
    const moderator = { userId: moderatorUser.id, roles: moderatorUser.roles };
    const report = await community.createReport({
      reporterUserId: 'reporter-private',
      targetType: 'POST',
      targetId: 'post-1',
      category: 'SPAM',
      details: 'Promotion',
      createdAt: new Date(),
    });

    const queue = await service.listReports(moderator);
    expect(queue.items[0]).not.toHaveProperty('reporterUserId');
    await expect(service.assignReport(moderator, report.id, moderator.userId)).resolves.toMatchObject({
      assignedToUserId: moderator.userId,
    });
    await expect(service.resolveReport(moderator, report.id, 'DISMISSED', 'Insufficient evidence')).resolves.toMatchObject({
      state: 'DISMISSED',
    });

    await expect(audit.list({ targetId: report.id, limit: 10, offset: 0 })).resolves.toMatchObject({
      total: 2,
      items: [
        expect.objectContaining({ action: 'MODERATION_CASE_RESOLVE' }),
        expect.objectContaining({ action: 'MODERATION_CASE_ASSIGN' }),
      ],
    });
  });

  it('returns only real user and moderation counts for authorized operators', async () => {
    const identities = new InMemoryIdentityRepository();
    const community = new InMemoryCommunityRepository();
    const library = new InMemoryLibraryRepository();
    const reputation = new ReputationService(
      new InMemoryReputationLedgerRepository(),
      new ContributionRuleEngine(),
      new AntiFarmingRuleEngine(),
    );
    const audit = new InMemoryAdminAuditRepository();
    const service = createService(identities, community, library, reputation, audit);
    const moderator = (await createUser(identities, 'moderator-metrics@example.com', 'Moderator', ['MODERATOR']))!;
    const active = await createUser(identities, 'active-metrics@example.com', 'Active', ['USER']);
    await identities.updateUser(active!.id, { status: 'DISABLED' });
    const pending = await createUser(identities, 'pending-metrics@example.com', 'Pending', ['USER']);
    await identities.updateUser(pending!.id, { status: 'VERIFICATION_PENDING' });
    await community.createReport({
      reporterUserId: 'private-reporter',
      targetType: 'POST',
      targetId: 'metrics-post',
      category: 'SPAM',
      details: 'Queue item',
      createdAt: new Date(),
    });

    await expect(service.metrics({ userId: moderator!.id, roles: moderator!.roles })).resolves.toMatchObject({
      users: { active: 1, verificationPending: 1, disabled: 1 },
      moderation: { openReports: 1, actionedReports: 0, dismissedReports: 0 },
    });
  });

  it('enforces admin-only role mutation and last-admin protection before persistence', async () => {
    const identities = new InMemoryIdentityRepository();
    const community = new InMemoryCommunityRepository();
    const library = new InMemoryLibraryRepository();
    const reputation = new ReputationService(
      new InMemoryReputationLedgerRepository(),
      new ContributionRuleEngine(),
      new AntiFarmingRuleEngine(),
    );
    const audit = new InMemoryAdminAuditRepository();
    const service = createService(identities, community, library, reputation, audit);
    const adminUser = (await createUser(identities, 'admin@example.com', 'Admin', ['ADMIN']))!;
    const moderatorUser = (await createUser(identities, 'moderator@example.com', 'Moderator', ['MODERATOR']))!;
    const admin = { userId: adminUser.id, roles: adminUser.roles };
    const moderator = { userId: moderatorUser.id, roles: moderatorUser.roles };

    await expect(service.replaceRoles(moderator, admin.userId, ['USER'])).rejects.toMatchObject({
      code: 'ADMIN_MODERATION_FORBIDDEN',
    });
    await expect(service.replaceRoles(admin, admin.userId, ['USER'])).rejects.toMatchObject({
      code: 'ADMIN_ROLE_ASSIGNMENT_REJECTED',
    });
    await expect(identities.findUserById(admin.userId)).resolves.toMatchObject({ roles: ['ADMIN'] });
  });
});

function createService(
  identities: InMemoryIdentityRepository,
  community: InMemoryCommunityRepository,
  library: InMemoryLibraryRepository,
  reputation: ReputationService,
  audit: InMemoryAdminAuditRepository,
): AdminService {
  return new AdminService(
    identities,
    community,
    new CommunityModerationService(community),
    new AdminModerationActionService(identities, community, library, reputation),
    audit,
  );
}

async function createUser(
  identities: InMemoryIdentityRepository,
  email: string,
  displayName: string,
  roles: readonly ('USER' | 'CONTRIBUTOR' | 'EXPERT' | 'MEMBER' | 'MODERATOR' | 'ADMIN')[],
) {
  const user = await identities.createUser({
    email,
    displayName,
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
  });
  return identities.replaceUserRoles(user.id, roles);
}
