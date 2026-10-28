# TEST OAuth-state cookie security

Scope: Backend dev only. Production main and both draft hotfix PR68s remain unchanged. Workspace draft185 is preserved. No Production environment/database/VPS/CI-gate mutation.

OAuth-state previously used Secure only when NODE_ENV=production, leaving HTTPS TEST without the flag. Controller start, account-link start and callback clearing now choose Secure when environment is production OR validated PUBLIC_APP_URL uses HTTPS. Startup validates this configured origin; request Host, protocol and forwarding headers cannot determine the flag. No new environment variable/provider change is required. localhost HTTP development remains supported. Refresh/CSRF session-cookie policy is unchanged by this task.

Attributes retained: HttpOnly; SameSite=Lax; Path=/api/v1/auth/oauth; no Domain (host-only); Max-Age600 on issue and0 on clearing. Existing timing-safe matching, missing/mismatch/duplicate rejection, state transaction expiry and single-use behavior remain unchanged. Tests explicitly check expiry at ten minutes, before any provider request.

TEST uses Vercel same-origin /api/v1 proxy to Render. PUBLIC_APP_URL and Google redirect URI remain the HTTPS Vercel frontend and its proxied callback. The browser receives and returns a Secure state cookie on that frontend host. Do not start on Render directly while redirecting back to Vercel: host-only state would belong to another host. Do not switch frontend API base to Render or relax SameSite/CORS/CSRF.

Regression RED: HTTPS TEST controller case failed with missing Secure (other5 passed). GREEN: focused controller/state/OAuth22 tests and HTTPS proxy HTTP3 tests passed. HTTPS Production and HTTP localhost issue/link/clear are covered; spoofed forwarding headers cannot downgrade HTTPS or upgrade localhost. HTTP E2E uses a simulated Google boundary and explicit cookie forwarding, not proof of live browser/provider acceptance. Full suite/CI and actual TEST deployment receipts are reported with the task PR.

Real Google consent/callback acceptance is owner-manual in an ordinary supported browser; Google blocks automated sign-in. Live acceptance must not be inferred from simulated tests. TEST post-deployment checks inspect only cookie attributes/HTTP outcomes, never cookie/access-token/provider-state values. Secure cookie issue and clear must both pass through the Vercel hostname; state remains HttpOnly. Rollback for this dev change is a reviewed code revert and TEST redeployment, without environment or schema edits; no Production rollback/deployment is authorized.
