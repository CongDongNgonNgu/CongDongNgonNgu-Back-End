# Cross-subdomain CSRF hotfix

Scope: congdongngonngu.vn frontend and api.congdongngonngu.vn backend. Production merge, deployment, environment changes, database writes/migrations and CI/CD activation are NOT authorized. Workspace draft PR185 is preserved.

## Decision and compatibility

Existing host-only cdn_csrf cannot be read by apex JavaScript. Existing cdn_refresh remains HttpOnly, Secure in production, SameSite=Lax and Path=/api/v1/auth. Neither cookie receives a Domain attribute. OAuth state validation, refresh rotation, replay-family revocation and identity linking are unchanged.

A parent-domain CSRF cookie would expose/inherit cookie scope across every sibling, require configuration and collide with the existing host-only cookie. Instead additive GET /api/v1/auth/csrf returns the API-host token in the normal success envelope: data.csrfToken is a string or null. Exact configured Origin is mandatory even without a session. Missing, null and unauthorized Origins fail403. Responses are private,no-store and do not issue cookies. Existing strict CORS allowlist and credentials policy are unchanged. No frontend-supplied Origin override or token in URL/storage/logs.

Cross-origin session mutations retrieve a fresh token immediately before sending X-CSRF-Token. No cached token survives rotation/reload. Public email/password login remains independent of token delivery and replaces canonical host cookies. Same-origin transport retains existing readable-cookie behavior. There is one extra GET per cross-origin authenticated mutation. Existing cross-tab refresh races are unchanged; the client still deduplicates refresh within its instance.

References: [OWASP CSRF token response delivery and subdomain risks](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [MDN cookie scoping](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

## Legacy cookies and recovery

No cookie-scope migration is required: existing single host-only cookies work immediately. Apex-only CSRF cookies are ignored for cross-origin requests. The API rejects duplicate CSRF or refresh cookie names instead of choosing a domain/path/order winner, including equal duplicates. This is deliberate fail-closed behavior.

If browser storage contains historical duplicate cookies, use browser developer tools Storage/Application for this application's two origins only. Remove cdn_csrf and cdn_refresh entries at api.congdongngonngu.vn, congdongngonngu.vn and .congdongngonngu.vn, including their recorded legacy paths. Do not clear all site/browser data, other cookie names, or unrelated application subdomains. Close this app's tabs, reopen it, then sign in to issue fresh host-only cookies. Removing browser cookies does not revoke server records; bounded refresh TTL remains in force. Where possible log out successfully before cleanup; request account-wide session revocation through the existing authenticated logout-all flow after reauthentication if needed. Never select a duplicate value as an authentication fallback. Negative HTTP tests exercise both duplicate orders; canonical-cookie OAuth/reload/logout and password-login replacement are covered separately. Recovery requiring browser storage cleanup is an explicit operational limitation, not automatic migration.

## Verification evidence (2026-10-28, Asia/Saigon)

Regression RED: backend auth E2E three failures (new endpoint404); frontend three failures without API token delivery. GREEN: focused auth E2E8/8; OAuth HTTP E2E3/3 with simulated Google provider responses covers registration, existing provider login, explicit account linking, callback session, refresh, reload, logout, replay. Final full E2E27 suites/215 tests passed. Unit223 suites/1585 passed,7 existing native-platform skips. Frontend final full146 suites/831 passed; focused final12/12. Both builds passed. Frontend audit0; backend high gate passed with6 low development-only Jest/deepmerge findings. CI/full final counts are recorded in PRs.

Real Chrome local fixture: app.cdnn.localhost:5175 and api.cdnn.localhost:3338 share cdnn.localhost but have distinct hosts/origins. Actual AuthApi and backend routes; memory-only identity repository; Google token/userinfo boundary simulated. Callback bootstrap, fresh AuthApi reload persistence, absent frontend-readable API cookie, missing/mismatched CSRF403 all passed on desktop and mobile390x844. Logout invalidation also passed; expected negative403 requests produced browser resource-error entries. This is local browser integration evidence, not live Google consent/provider or Production acceptance. Secure production cookie attributes and expiry are unit-tested separately.

## Production proposal and prechecks (not executed)

1. Prepare separate hotfix branches from current main (Backend9f1d6b50dd5d33d312feba0fa23fa4d1e2d46682; Frontend8777545f1d42ffe85e37e2ce5f1d7c8ff9030fea). Apply only this fix/tests/runbook. Verify no dev feature/Swagger/deployment-workflow/lockfile history enters the proposal. Require exact hotfix PR CI and independent review. No main merge without separate owner approval.
2. Before any future VPS action, independently verify deployed backend/frontend SHAs and dirty state; do not assume main equals deployed runtime. Inspect effective Nginx app roots/upstreams, existing PM2 owner/name/cwd/script/interpreter/args/environment source and listener correlation without printing secrets. Current dev runtime-contract.json is reviewed=false with unresolved restart/provenance gates. Those gates remain blockers; this runbook does not approve restart or bootstrap. Do not run existing deploy helpers while blocked.
3. Preserve verified previous app artifacts and exact frontend asset set. Record ownership/modes and private hashes of existing Production .env; never copy .env into Git, build artifacts, logs or chat. Confirm existing PUBLIC_APP_URL, GOOGLE_OAUTH_REDIRECT_URI, API base, exact CORS apex origin, NODE_ENV=production through sanitized presence/equality checks only. No new environment variable is required. Preserve database connection and all unrelated applications. No migrations, SQL, schema sync, seeding or npm audit force-fix.
4. Build approved immutable artifacts in isolation using each main hotfix lockfile and supported Node. Check checksums, dependency audits, frontend API target and absence of secrets. Existing Production gates remain false. Obtain separate explicit approval for exact SHAs, app paths, scoped restart/switch method, postchecks and rollback. Verify sufficient disk/headroom and recovery capability before activation.

## Future activation and postchecks (approval required)

Deploy backend first: additive endpoint supports the old frontend; deploy frontend second. Use only separately reviewed app-specific release/switch operations after runtime provenance and rollback rehearsal gates pass. Scope backend to the confirmed /var/www/congdongngonngu/backend app; discover/verify frontend root rather than guessing it. Never restart all PM2 apps, change daemon persistence, alter Nginx globally or use a broad directory sync/delete. Preserve .env, database and other VPS apps byte-for-byte.

Postchecks over HTTPS: exact artifact/deployed revision and app health; allowed-origin CSRF GET200,no-store and unchanged CORS credentials; absent/foreign/null Origin403 without token; refresh without/mismatched header403; Secure/HttpOnly refresh cookie with no Domain and unchanged paths/SameSite. In an isolated approved test account exercise real Google registration/login/linking, email login, refresh, page reload, mobile/desktop and logout; expiration/replay negative tests stay in isolated test sessions to avoid revoking an owner's active session. Confirm unrelated app health and no persistent environment/database change. Never log raw cookies/access tokens.

## Rollback (approval required)

On failed health/auth/CORS/cookie postchecks stop rollout. If frontend changed, restore its retained exact asset set first, then restore the retained backend artifact using the reviewed app-scoped process; recheck exact previous revisions, health and unrelated apps. Preserve .env and database; no schema rollback exists or is needed. Old frontend may retain the original OAuth CSRF symptom after rollback. If sessions were rotated during verification, reauthenticate the isolated test account rather than editing session data. Record failed gate and evidence; do not enable Production automation or broaden rollback to unrelated applications.

Independent code/security review found no remaining blocker for dev integration or a narrow main proposal, conditional on required CI. Production approval/runtime gates remain mandatory.
