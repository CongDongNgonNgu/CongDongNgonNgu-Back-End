# Runtime/bootstrap preparation checkpoint ? 2026-10-27

Scope: application dev source preparation only; no Production access or mutation. Workspace Swagger draft PR #185 and its checked-out branch are unchanged.

## Source identity and provenance

- Backend full source SHA: 9f1d6b50dd5d33d312feba0fa23fa4d1e2d46682.
- Frontend full source SHA: 8777545f1d42ffe85e37e2ce5f1d7c8ff9030fea.
- Both were resolved from owner-reported short revisions and fetched Git history. Existing Production dist/dependency artifact provenance remains UNVERIFIED. Clean Git HEAD is not accepted as build evidence.
- Required artifact evidence: independently reviewed immutable build/archive or reproducible exact-SHA manifest matching all current dist bytes, inherited frontend assets, Backend installed dependencies/package/lock digests and actual Node ABI/build settings.

## Runtime disposition

Backend contract stays reviewed:false. Confirmed owner metadata is recorded without inventing absent arguments. Remaining inspection: resolved live Node executable/version (Node24 gate), instances, node_args/interpreter_args, application args, NODE_OPTIONS and PM2 restart/watch/memory/readiness/termination options. Sanitized inspector and exact read-only operator commands are in [the bootstrap runbook](../../scripts/deploy/BOOTSTRAP.md).

User-confirmed runtime: cdnn-deploy, PM2_HOME=/home/cdnn-deploy/.pm2, enabled/active pm2-cdnn-deploy, PM2 7.0.3, online cdnn-backend, zero restarts; stable backend cwd/script, node/fork, port3201 and production health. Owner-reported real dist directories, 39GB free, clean worktrees and no releases directory are retained as observations, not independently measured VPS evidence.

## Implementation and verification boundaries

- Separate manual bootstrap plan/apply/recovery entry point; no workflow calls it.
- Immutable approval digest; provenance/runtime/Nginx gates; deployment flock; canonical path checks; disk reserve; complete staged hash comparison; dependency resolution inside baseline node_modules; original env inode/permissions preserved without reading its content.
- Durable file/directory fsync and journal; real Linux renameat2 atomic exchange, retained original directory, no nonempty dist replacement, no restart and no unsafe maintenance-gap fallback.
- Failure restore is explicitly part of the approved apply operation; standalone post-crash recovery has a separate current-state approval digest.
- Portable tests pass locally on Windows. Actual Linux exchange, SIGKILL, recovery/rollback, restrictive umask and lock/failure-injection tests are mandatory in each repository's existing CI deployment-safety step. Read exact PR/dev CI receipts for outcomes; Windows skips do not establish Linux/VPS acceptance.
- Independent adversarial review findings on umask, runtime drift and crash coverage were fixed and re-reviewed. External cross-model CLI was skipped in autonomous execution.
- Existing application/native/SQL/security gates remain required; Linux CI uses ephemeral localhost PostgreSQL. Bootstrap tests use only isolated temporary synthetic trees with no network verifier or database.

## Operational verdict

Preparation source can be integrated only after required PR CI passes. Production readiness remains BLOCKED by runtime review, baseline artifact provenance, Nginx symlink-policy/worker-permission evidence and separately approved real VPS bootstrap/rollback verification. Both literal-false activation gates remain; application main is unchanged. No Production .env, Neon, service or directory has been changed. No actual bootstrap, restart or rollback has been executed.

The [operator procedure](../../scripts/deploy/BOOTSTRAP.md) contains exact future commands, impact, automatic-restore behavior, manual recovery authorization and postchecks. Existing [Workspace secure CI/CD runbook](https://github.com/CongDongNgonNgu/CongDongNgonNgu-Workspace/blob/main/docs/operations/SECURE-CI-CD.md) remains authoritative; Workspace is never deployed.
