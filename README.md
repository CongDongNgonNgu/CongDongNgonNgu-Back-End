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
