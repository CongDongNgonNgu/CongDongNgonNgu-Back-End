# Backend production dependency security remediation — 2026-10-26

## Revision and scope

- Requested baseline: `b3be9e28c6c4596ded3ed35726c57846ec8870da`.
- Examined checkout: `505750bed22d7f93defc896a3209bc435ac6cf5a` (clean before this task). A read-only `git ls-remote origin refs/heads/main` confirmed the same remote main SHA.
- Existing dependency remediation commit: `b06af78487648fcfe665c49cb75862c53a4d1736`, already an ancestor of this checkout. The requested baseline is also an ancestor. No checkout rollback, Nest major change, `npm audit fix`, or production deployment was performed.
- Follow-up changes included with this report: `.npmrc` blocks install lifecycle scripts; the HTTP exception filter preserves safe parser client errors; six application e2e parsing regressions cover the behavior.

## Resolved dependency tree

| Package | Requested baseline lock | Verified installed lock |
| --- | --- | --- |
| @nestjs/common, core, platform-express, testing | 12.0.1 | 12.0.1 |
| @nestjs/config, cli, schematics | 12.0.0 | 12.0.0 |
| express | 5.2.1 | 5.2.1 |
| body-parser | 2.3.0 | 2.4.0 |
| multer | 2.4.0 | 2.5.0 |
| fast-uri | 3.1.8 | 3.1.9 |
| qs | 6.16.0 | 6.16.1 |

`npm ls --all --json` completed with exit 0 after clean installation. No duplicate versions of body-parser, multer, or fast-uri exist in the lock. Nest peer contracts remain satisfied. Express accepts body-parser through its existing `^2.2.1` range. Multer remains in major 2 through the existing override, now pinned to 2.5.0. fast-uri is development-only, under Nest CLI → Angular devkit / webpack schema utilities → ajv; production parsing is Nest platform-express → express → body-parser.

Upstream patch references: [body-parser advisory](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828), [Multer advisory](https://github.com/expressjs/multer/security/advisories/GHSA-q7qp-rjg7-q26m), [fast-uri host canonicalization advisory](https://github.com/fastify/fast-uri/security/advisories/GHSA-wjr9-j795-jxcr). The full audit below covers all current reported advisories, beyond these references.

## Installation and npm 11 scripts

- Verified using Node 24.18.0 and npm 11.16.0 on Windows; commands used `npm.cmd` because PowerShell blocks the npm.ps1 shim.
- `npm ci`: PASS, 601 packages installed, 0 vulnerabilities. Project `.npmrc` has `ignore-scripts=true`; no dependency lifecycle scripts were allowed to execute.
- Lock entries with install scripts: `@parcel/watcher@2.6.0` and `unrs-resolver@1.12.2`. Reviewed entrypoints: the former can invoke node-gyp for a source build; the latter invokes napi-postinstall package preparation. Neither was approved to run. Future packages are also blocked by this policy.
- sharp 0.35.5 loads successfully from its installed platform package with scripts disabled; build and tests also work under this policy. Explicit `npm run` commands remain available.
- npm emitted a deprecation notice for transitive glob 10.5.0. Both registry audits returned zero; no unrelated major upgrade was made in response to a generic notice.
- npm's [script policy documentation](https://docs.npmjs.com/cli/v11/using-npm/config/#allow-scripts) distinguishes lifecycle-script approval from explicit project commands. Do not override this repository policy to silence warnings; review any newly required script first.

## Application regression discovered during verification

The existing catch-all exception filter classified Express http-errors (including body size and gzip decoder failures) as internal errors. New tests reproduced 500 responses for invalid gzip and oversized JSON. The filter now normalizes only client statuses 400, 413 and 415 from Error objects whose status/statusCode match and expose flag is true. Fixed messages preserve the existing API failure envelope without returning request bodies or decoder details. Other exceptions retain the existing handling.

Six new e2e cases exercise URL-encoded registration, valid compressed JSON registration, malformed JSON, gzip with trailing garbage, unsupported encoding, and oversized JSON. Requests after parser rejection confirm the application is still alive. Compressed bytes use native HTTP to avoid Supertest JSON serialization of Buffer payloads.

Existing auth e2e exercises registration, verification, login, refresh rotation/replay, logout and CSRF. Existing attachment HTTP tests exercise authenticated raw uploads, identity handling and private byte responses. Application uploads use raw request streams; there are no production FileInterceptor/FilesInterceptor or custom Multer upload handlers to migrate. SQL upload/auth integration results are recorded below separately from the synthetic HTTP application boundary.

## Verification

| Check | Result |
| --- | --- |
| npm ci, scripts blocked by project policy | PASS |
| npm audit --omit=dev | PASS — 0 vulnerabilities |
| npm audit | PASS — 0 vulnerabilities |
| npm ls --all --json | PASS |
| npm run typecheck | PASS after HTTP filter change |
| npm run lint | PASS after HTTP filter change; repository lint currently invokes tsc --noEmit |
| npm run build | PASS after HTTP filter change |
| npm test -- --runInBand | PASS — 220 suites, 1,558 tests; 7 existing native-video tests skipped |
| npm run test:e2e -- --runInBand | PASS — 25 suites, 186 tests, no skips |
| npm run test:attachments -- selected auth/upload/access/upload-service proof paths | PASS - 4 suites, 50 tests; exact approved TEST database guard passed; owned random schemas |
| git diff --check | PASS |

The selected SQL proof commands were:

```text
npm run test:attachments -- test/phase30/attachment-auth.sql-spec.ts test/phase30/attachment-upload.sql-spec.ts
npm run test:attachments -- test/phase30/attachment-access.sql-spec.ts test/phase30/attachment-upload-service.sql-spec.ts
```

Both commands exited 0: auth/upload passed 28 tests, access/upload-service passed 22 tests. Durable temporary logs are `CongDongNgonNgu-security-auth-upload-20261026.log` and `CongDongNgonNgu-security-access-upload-service-20261026.log` under the Windows TEMP directory. An earlier full attachment SQL run lost its tool session before a final result was captured; it is not claimed as a successful full-suite run. Individual finalize-service, upload-service, quota and upload suites had passed before that interruption.

## Remaining limits

- Seven existing native video pipeline tests require explicitly packaged processor binaries and were skipped by their existing guard. Linux VPS native processor acceptance is not established by this Windows run.
- The script policy, filter correction, six regression tests and this report form a follow-up commit authorized on 2026-10-27. The original dependency remediation SHA above does not contain these additions.
- No production deployment or live provider/storage smoke test was performed. Audit results describe the registry response at the verification time, not a guarantee against future advisories.
