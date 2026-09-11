# CongDongNgonNgu Backend

This repository is the independent backend for CongDongNgonNgu. Phase 02 adds
the identity model, email/password auth, verification and recovery tokens,
server-tracked sessions, OAuth provider boundaries, explicit account linking,
and protected-route authorization primitives.

## Local commands

```text
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Copy `.env.example` to `.env` and replace local placeholders before starting
the server. The validator rejects known external-product hostnames in the
database URL, public URL, and CORS origins. Provider integrations default to
`disabled` and are not initialized by this baseline.

The API prefix is /api/v1; the public readiness endpoint is
GET /api/v1/health. Auth routes include /auth/register, /auth/login,
/auth/verify-email, /auth/resend-verification, /auth/forgot-password,
/auth/reset-password, /auth/refresh, /auth/logout, /auth/logout-all,
/auth/me, and provider capability/OAuth start-callback routes.

Phase 03 profile routes are:

~~~text
GET   /languages
GET   /profile                         authenticated own projection
PATCH /profile                         authenticated own replacement update
GET   /profiles/:userId                public projection
~~~

Phase 04A language hub routes are:

~~~text
GET   /languages/:slug                 active canonical language identity
GET   /languages/:slug/overview        truthful hub overview contract
~~~

The overview contract is shared by every active language. Metrics use
explicit unavailable states until real learner, contributor and resource
data exists. The overview section is the only currently available and
navigable section; Vocabulary, Grammar, Sentences, Pronunciation, Resources,
Community, Questions, Practice and Exchange are explicitly marked
NOT_IMPLEMENTED and are not dead links.

The overview accepts optional level filters as repeated or comma-separated
query values, for example /languages/english/overview?level=A1&level=B2.
Levels are case-insensitive, deduplicated and returned in A1-to-C2 order.
Topics are Unicode-normalized, trimmed, lowercased and converted to stable
hyphenated values; blank topics are absent. A syntactically valid topic with
no backed data is echoed with NOT_AVAILABLE_YET status, while invalid levels
and topic syntax return LANGUAGE_INVALID_LEVEL or LANGUAGE_INVALID_TOPIC.

Profile updates accept language codes from the active catalog, language roles
('native', 'known', 'learning'), declared proficiency ('NATIVE', 'A1' through
'C2'), optional goals/skills/interests, an IANA timezone, and optional
availability windows. Lists are bounded and replacing a list is atomic. A
primary learning target is represented on exactly one learning relation, or
none. Availability uses local wall-clock minutes and half-open ranges;
cross-midnight availability must be split at '24:00'.

The own projection may include the account email, timezone, exact availability
and private language relations. The public projection contains only the
display name, public language relations, goals, skills and interests; it does
not include email, roles, provider identifiers, timezone, security metadata or
exact availability.

Refresh credentials are server-tracked, rotated, replay-detected, and held in
an HttpOnly cdn_refresh cookie scoped to /api/v1/auth. A readable cdn_csrf
cookie and matching header protect cookie-backed mutations. Access tokens are
short-lived and kept by the client in memory; raw refresh, verification, reset,
and OAuth secrets are never logged.

Google, Facebook, Zalo, and Apple are independently configured. They fail
closed while disabled or incomplete; no EduAI/Firebase credentials or
provider identities are reused. Email delivery is memory-backed only for
tests/local development and fails closed in production until a configured
provider is supplied.
There are intentionally no course, lesson, classroom,
assignment, quiz, certificate, job, mentor, AI, commerce, payment, or
membership routes in this repository.

## CI and deployment boundary

CI runs on pull requests and pushes to `main` and checks install, lint, types, unit/e2e tests, build, and dependency audit. Phase 00 configures no deployment workflow; production deployment remains a separate approved task.

## Implementation references

The baseline follows the NestJS guidance for configuration, validation, CORS,
exception filters, and the v12 CommonJS/ESM boundary:

- https://docs.nestjs.com/techniques/configuration
- https://docs.nestjs.com/techniques/validation
- https://docs.nestjs.com/security/cors
- https://docs.nestjs.com/exception-filters
- https://docs.nestjs.com/migration-guide
