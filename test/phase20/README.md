# Phase 20 synthetic authorization experiment

Run `npm run test:e2e -- --runInBand --testPathPatterns=phase20`.
The e2e runner here exercises a policy/service boundary, not HTTP or deployed DB.
The frozen contract is in Workspace
`phases/PHASE-20-STUDY-GROUP-AUTH-EXPERIMENT/POLICY-MATRIX.md`.

Only disposable local TEST memory is used. No routes, migrations, app providers,
existing PRIVATE semantics or production environment settings are changed.
`tsconfig.build.json` excludes `test`; no production module imports this adapter.
Cleanup assertions clear all adapter fixtures and deny post-disposal reuse.
The CommunityService PRIVATE regression uses existing in-memory repositories,
local variables released after the test; nothing is written externally.

36 policy cases cover roles, group IDOR, hashed expiring one-use invitations,
concurrent redemption/revocation, leave/remove/stale claims, ownership transfer,
moderation/report authority, uniform errors, projections, bounds and cleanup.
Notifications/storage/cache are bounded adapter projections, not proof of
existing provider delivery, signed URLs or distributed cache infrastructure.

Synchronous transitions establish single-process linearization only.
Phase 22 must separately prove SQL transaction/locking/uniqueness/rollback,
multiple workers, account-disable/global-block integration, durable retention,
safe backup and distributed projections. A technical GO is not user demand.

Required audit remediation updates only the proxy-addr lock entry to 2.0.8:
https://github.com/advisories/GHSA-jqcg-44mw-7w3h . No security setting is relaxed.
Current 20 moderate development-tree audit findings remain below the repository
high-severity gate; review by 2026-10-14 or before the next dependency update.
