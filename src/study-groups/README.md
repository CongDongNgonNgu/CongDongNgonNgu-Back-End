# Bounded text study groups

StudyGroupModule owns one lazy PostgreSQL pool and closes it on module shutdown. StudyGroupService accepts an externally supplied Pool for isolated integration tests; it never closes that caller-owned pool. No memory adapter or group notification/store projection exists.

Every operation locks ACTIVE user accounts in UUID order, then group rows. Writes use FOR UPDATE; reads use FOR SHARE. Membership-changing writes also lock the affected account before the group, so group lists and per-account quotas cannot race joins/removal. Membership/role rechecks and safe response projection occur inside the transaction. Group owners are enforced by a deferred ACTIVE/OWNER composite FK and a separate partial unique index, not session/platform roles.

The module middleware sets private,no-store before authentication. The controller requires AccessTokenGuard, DTO validation, and existing cookie CSRF protection for mutations. Limits and fixed-window counters are PostgreSQL-backed; a separate rate transaction commits valid authenticated attempts even if later group authorization fails. No raw invitation token is persisted or logged. The owner-only invitation metadata API supports revocation after reload.

Migration 0027 is additive; its down file is disposable TEST/development only. Do not execute db:migrate against an unclassified connection. Real SQL tests under test/phase22 prove database behavior; migration text tests only guard scope. Actual production release and real private-data collection remain held by Workspace policy.

The frozen pilot requires every affected account to be ACTIVE. A disabled member remains a retained active membership and consumes capacity; it cannot be removed or promoted while disabled. A disabled owner cannot transfer ownership until account recovery or a separately reviewed safety policy exists. Disabled accounts receive no protected group access. This is a disclosed TEST limitation, not a platform-role bypass.
