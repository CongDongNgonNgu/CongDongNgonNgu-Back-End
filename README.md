# CongDongNgonNgu Backend

This repository is the independent backend foundation for CongDongNgonNgu.
The Phase 00 baseline intentionally contains only the application boundary,
validated runtime configuration, health endpoint, security headers, request
validation, and focused tests. Language, community, identity providers,
realtime, storage, AI, and commerce schemas are introduced only by their
approved later phases.

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

The API prefix is `/api/v1`; the public readiness endpoint is
`GET /api/v1/health`. Session, OAuth, AI, email, storage, realtime, and payment providers are represented by independent environment controls and remain disabled until a later phase. Marking one configured fails startup when its required endpoint or sensitive credential is missing.
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
