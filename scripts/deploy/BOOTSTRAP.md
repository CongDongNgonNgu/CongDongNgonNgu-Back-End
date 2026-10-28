# One-time dist bootstrap: preparation only

**Production apply, recovery, service restart and filesystem conversion have NOT been authorized or executed.** The automatic Production caller and callee gates remain literal `false`. This helper is never invoked by a workflow or release.sh. Workspace is documentation only and must never be transferred to the VPS.

## Current blockers and known source revisions

Backend source: `9f1d6b50dd5d33d312feba0fa23fa4d1e2d46682`.
Frontend source: `8777545f1d42ffe85e37e2ce5f1d7c8ff9030fea`.
These resolve the owner-reported short revisions through Git history. A clean worktree or `git rev-parse HEAD` does **not** establish the provenance of existing dist or dependencies.

Backend runtime-contract.json retains `reviewed:false`. See [the current runtime contract and readiness decision](../../docs/deployment/RUNTIME-READINESS.md): observation review preserves missing PM2 fields and cannot approve restart safety.

PM2 user/home/service/process remain `cdnn-deploy`, `/home/cdnn-deploy/.pm2`, `pm2-cdnn-deploy`, `cdnn-backend`. Owner reports PM2 7.0.3, enabled/active service, online process and zero restarts. This preparation does not independently inspect the VPS or turn those observations into artifact provenance.

## Read-only evidence first

An operator must separately approve any VPS access and helper transfer. Use a private preparation directory OUTSIDE the production Git worktree containing only these reviewed deploy helper files from the exact green dev revision; verify their transfer hashes. Do not checkout dev, run git reset/clean, install packages, or replace the application worktree.

Example helper locations used by the commands below:

- `/home/cdnn-deploy/bootstrap-preparation/backend/scripts/deploy/`
- `/home/cdnn-deploy/bootstrap-preparation/frontend/scripts/deploy/`

Under the existing cdnn-deploy identity, collect only sanitized metadata:

```bash
id -un
systemctl is-active pm2-cdnn-deploy
systemctl is-enabled pm2-cdnn-deploy
PM2_HOME=/home/cdnn-deploy/.pm2 node /home/cdnn-deploy/bootstrap-preparation/backend/scripts/deploy/check-runtime.cjs --inspect
stat -c '%U %a %F' /var/www/congdongngonngu/backend/.env
stat -c '%U %a %F' /var/www/congdongngonngu/backend/dist /var/www/congdongngonngu/frontend/dist
df -h /var/www/congdongngonngu/backend /var/www/congdongngonngu/frontend
git -C /var/www/congdongngonngu/backend rev-parse HEAD
git -C /var/www/congdongngonngu/frontend rev-parse HEAD
bash /home/cdnn-deploy/bootstrap-preparation/backend/scripts/deploy/bootstrap.sh --plan
bash /home/cdnn-deploy/bootstrap-preparation/frontend/scripts/deploy/bootstrap.sh --plan
```

Plan mode only reads filesystem/PM2 metadata and emits JSON to stdout, including current dist/dependency hashes and exact blockers. It does not create a lock, release directory, marker or symlink. Non-ready plans exit 2. The inspector refuses an inactive/missing PM2 daemon; never start a daemon to inspect it. It reads getMonitorData through the existing rpc.sock into memory using only the installed PM2 7.0.3 transport modules, without constructing PM2 API/Client/CLI startup helpers. Socket failure/timeout is terminal; no daemon startup fallback exists. It emits only allowlisted fields, not raw environment, command lines or credentials. The actual host package/socket compatibility remains unverified until this read-only inspection is separately executed. Unsupported arguments/options are redacted/null and remain blocking. Do not publish raw `pm2 jlist`, `pm2 env`, `/proc/*/environ`, `.env`, or arbitrary application arguments. If sanitized fields are null, inspect the exact launch declaration locally with the operator, review the missing flags without disclosing secrets, and adapt/review the contract before proceeding. Inspect output is always `reviewed:false`; a separate reviewed source change is required to mark it true.

Inspect the applicable Nginx server configuration read-only: root must remain `/var/www/congdongngonngu/frontend/dist`; verify `disable_symlinks`/owner rules permit the new app-local link and every ancestor is traversable by the actual worker. Review read permissions as that worker (via an operator-authorized read-only `test -r`/`test -x`, not permission changes). Record the current entry JS/CSS URLs and successful public responses for later recovery comparison. A symlink being valid for cdnn-deploy does not prove Nginx can use it.

## Required artifact provenance

Start from bootstrap-evidence.example.json; its null/false values deliberately block apply. Supply evidence only after comparing the observed content with a trusted immutable build/archive manifest or an independently reproduced exact-SHA build with its original compiler/lockfile/build settings. Record the immutable reference and actual reviewer in `provenance`; copying observed hashes into the template alone is **not verification**. Source SHA must equal the pinned baseline source above.

- Match the complete current dist content tree digest to that reviewed manifest. Trees reject external symlinks, hardlinks, special files and runtime environment files. Existing frontend inherited hashed assets must be included and identified in provenance; do not pretend a historical asset union equals a clean new build, delete assets, or rebuild over the served directory to force a match.
- Backend additionally binds exact installed node_modules, package.json and lockfile digests. Verify the dependency graph and native ABI are compatible with the running Node binary. Bootstrap copies existing compatible dependencies; it never runs npm install/ci/build or opens Production .env.
- Frontend records the independently verified `productionApiOrigin` as `https://api.congdongngonngu.vn/api/v1`, plus reviewed Nginx root/symlink policy. Static checks also reject a missing Production API or TEST API in JavaScript. Confirm actual currently served browser network origin read-only; do not infer it from the `.env` filename.
- If original build/archive provenance cannot be established, STOP. Keep real dist and runtime-contract blocking gates. A new known build/release or maintenance migration needs a separate design and explicit owner authorization; do not label existing bytes as HEAD.

## Eligible plan and separately approved apply

After runtime/provenance/Nginx evidence is reviewed, deliver the separately reviewed helpers/contract and evidence JSON under the private preparation directory. Re-run each read-only plan with its evidence:

```bash
bash /home/cdnn-deploy/bootstrap-preparation/backend/scripts/deploy/bootstrap.sh --plan --evidence /home/cdnn-deploy/bootstrap-preparation/backend-evidence.json
bash /home/cdnn-deploy/bootstrap-preparation/frontend/scripts/deploy/bootstrap.sh --plan --evidence /home/cdnn-deploy/bootstrap-preparation/frontend-evidence.json
```

Review `ready:true`, the complete plan and emitted 64-character `digest`. Approval binds app path/inode, dist inode/content, exact source/dependency/package hashes, environment metadata, reviewed runtime fingerprint, intended target paths and provenance document. Disk must allow two copies plus a 512MiB reserve. Free space is reported but excluded from the approval digest to avoid changes from unrelated disk activity; it is checked again at apply planning. Changes to approved artifacts/runtime invalidate the plan. `ready:true` does not certify filesystem exchange support; apply probes that capability on the same filesystem before touching live dist.

**The following commands mutate Production and MUST NOT be run until the operator explicitly approves the specific plan.** Replace each placeholder only with that app's reviewed digest; no digest has been obtained from the real VPS in this task.

```bash
bash /home/cdnn-deploy/bootstrap-preparation/backend/scripts/deploy/bootstrap.sh --apply --evidence /home/cdnn-deploy/bootstrap-preparation/backend-evidence.json --approve <BACKEND_PLAN_DIGEST>
bash /home/cdnn-deploy/bootstrap-preparation/frontend/scripts/deploy/bootstrap.sh --apply --evidence /home/cdnn-deploy/bootstrap-preparation/frontend-evidence.json --approve <FRONTEND_PLAN_DIGEST>
```

Apply approval explicitly includes automatic restoration of original dist on ordinary copy/exchange/health verification failure while holding the same deploy lock. This is part of the `bootstrap-with-automatic-restore` operation bound into the plan digest. Later manual/post-crash recovery requires its own current-state digest and approval.

## Transaction and retained recovery material

Apply holds the existing per-app `.deploy.lock` with nonblocking flock. Real/symlink path checks precede lock creation. It never replaces a nonempty directory with `rm` or ordinary rename.

1. Validate canonical app/target paths, ownership/permissions, evidence and snapshot. Refuse existing baseline/journal/backup paths, foreign symlinks and target collisions.
2. Copy existing dist into `.releases/baseline-<40-char-SHA>/dist`; for Backend copy exact node_modules and package/lock metadata into the same release. Preserve original root dependencies and Production .env inode/owner/mode 600.
3. Verify copied digests; add truthful `.source-sha`. Frontend adds/validates `dist/cdnn-release.json` only after provenance acceptance. Preserve all old assets; set newly created public ancestor directories explicitly to 711 and dist directories/files to 755/644 even under umask 077. Backend release/source metadata remain private.
4. Resolve every declared Backend runtime dependency from the staged dist entry using Node's realpath-based lookup; reject lookup outside that baseline's node_modules. No application module is executed and no DB connection is opened. No .env is copied into the release. Confirm original .env metadata remains unchanged.
5. Fsync copied files/directories, stage a relative sibling symlink `.bootstrap-original-<SHA>`, persist the journal with original inode/content identities and final staged content hash, fsync parents. Revalidate live snapshot and PM2 fingerprint immediately before activation.
6. Use Linux libc `renameat2(RENAME_EXCHANGE)` to atomically exchange the nonempty real dist directory with the staged symlink. The old real directory remains at `.bootstrap-original-<SHA>`; `.releases/baseline-<SHA>/dist` is the active recoverable baseline. Python3/libc/filesystem support is required; there is no unsafe fallback.
7. Validate actual endpoints, baseline hashes and dependency resolution, then public health/assets/API/redirect/marker via verify.cjs. No PM2 restart, Nginx reload, database operation, env edit or automatic release pruning occurs. Record durable `verified` only after checks pass. Partial staging and failed releases are retained for operator diagnosis.

Resulting layout:

```text
backend/.releases/baseline-<verified-SHA>/{.source-sha,package.json,package-lock.json,dist/,node_modules/}
backend/dist -> .releases/baseline-<verified-SHA>/dist
frontend/.releases/baseline-<verified-SHA>/{.source-sha,dist/{cdnn-release.json,index.html,assets/}}
frontend/dist -> .releases/baseline-<verified-SHA>/dist
```

## Post-bootstrap and recovery commands: separate approval required

Read-only postchecks:

```bash
bash /home/cdnn-deploy/bootstrap-preparation/backend/scripts/deploy/bootstrap.sh --verify
bash /home/cdnn-deploy/bootstrap-preparation/frontend/scripts/deploy/bootstrap.sh --verify
stat -c '%U %a' /var/www/congdongngonngu/backend/.env
systemctl is-active pm2-cdnn-deploy
```

Also compare frontend preflight hashed JS/CSS URLs byte-for-byte via public HTTP, and PM2 sanitized metadata/status/restart counter with preflight. PM2 must not have restarted. Health of an already running process does not prove a future PM2 restart from the symlink; actual restart/operational rollback remains a separately approved and unverified gate.

After an interruption, keep deployment locks/gates in place and obtain a read-only recovery classification before deciding anything:

```bash
bash /home/cdnn-deploy/bootstrap-preparation/backend/scripts/deploy/bootstrap.sh --recovery-plan
bash /home/cdnn-deploy/bootstrap-preparation/frontend/scripts/deploy/bootstrap.sh --recovery-plan
```

After explicit approval of that current recovery plan:

```bash
bash /home/cdnn-deploy/bootstrap-preparation/backend/scripts/deploy/bootstrap.sh --recover --approve <BACKEND_RECOVERY_DIGEST>
bash /home/cdnn-deploy/bootstrap-preparation/frontend/scripts/deploy/bootstrap.sh --recover --approve <FRONTEND_RECOVERY_DIGEST>
```

Recovery classifies actual inode/type/hash/target endpoints, not journal phase alone. Before exchange it verifies original dist remains live; after exchange it atomically restores the retained original directory. It handles a crash after exchange but before journal update, after commit, and during reverse exchange. Repeated recovery is safe with a freshly reviewed digest. Modified backup/baseline, foreign target or ambiguous state is refused for manual investigation; no destructive best-effort repair occurs. Old directories/releases are never removed automatically. If the original frontend had no cdnn-release.json, restoring it correctly removes that newly introduced marker; verify the original site and recorded JS/CSS URLs directly, not the new-release marker gate.

No planned maintenance outage is required for a supported atomic exchange of byte-identical reviewed baseline assets. During a failed postcheck, the approved immediate restore returns original dist without service restart. A host/filesystem without exchange support is BLOCKED. Do not fall back to moving/deleting the live directory. If a future alternative requires a maintenance window, separately authorize suspension of frontend asset reads/new Backend module loads during the pathname gap and an exact restoration plan; this implementation does not perform such a fallback.

## Tests and scope

`node --test scripts/deploy/*.node-spec.cjs` runs portable provenance/plan checks and Linux real-exchange integration. Linux tests use only mkdtemp synthetic files/dependencies, no network verifier, real VPS paths, Production .env or database. They cover umask077, module resolution after symlink activation, old assets/marker, stale evidence/approval, runtime drift, copy/exchange/health/fsync failures, path escapes, lock contention, tamper refusal, SIGKILL at journal boundaries and during recovery. Existing Linux release/rollback tests remain active. Windows skips kernel-specific tests; green Linux CI is required, not optional.

Background references: [Node module realpath resolution](https://nodejs.org/api/modules.html), [Linux atomic exchange](https://man7.org/linux/man-pages/man2/renameat2.2.html), [PM2 runtime options](https://pm2.keymetrics.io/docs/usage/application-declaration/). Existing Workspace runbook remains the cross-repository policy; this procedure supplements its bootstrap gate without activating Production.

## Runtime and provenance investigation

See [the read-only evidence and separately gated migration design](../../docs/deployment/RUNTIME-PROVENANCE.md). Reproducible-build content provenance is reviewed PASS. Runtime/bootstrap gates remain BLOCKED; effective Nginx policy is reviewed and future live traversal remains pending; isolated comparison reports alone cannot approve bootstrap.

## Runtime readiness follow-up ? 2026-10-28

See [RUNTIME-READINESS.md](../../docs/deployment/RUNTIME-READINESS.md) for the separate observation/restart gates, operator Nginx evidence, remaining blockers and minimal read-only commands. Reuse the reviewed reproduction result. Production gates remain disabled; no apply or restart is authorized.

## Verified operator evidence and PM2 rehearsal - 2026-10-28

Effective Nginx policy is reviewed off after successful syntax/dump checks; current worker access passes. Future live release traversal remains a post-activation check. Five inspection helper hashes match reviewed Backend PR #63; current/saved compared launch metadata has no differences, while instances/PORT/NODE_ENV remain null. See [operator evidence](../../docs/deployment/OPERATOR-EVIDENCE-2026-10-28.json) and [PM2 persistence/recovery scope](../../docs/deployment/PM2-PERSISTENCE-RECOVERY.md). Observation PASS cannot authorize restart; strict Production gates remain unchanged.

## Consolidated host configuration and acceptance

Host systemd configuration identity and configured persistence source are operator-verified; actual Production restart/reboot is not tested. Use [BOOTSTRAP-ROLLBACK-ACCEPTANCE.md](../../docs/deployment/BOOTSTRAP-ROLLBACK-ACCEPTANCE.md) for preservation, exact approval boundaries, acceptance and rollback stop conditions. Correlation remains a separately designed read-only check; strict runtime and activation gates remain blocked.

## Implemented process and restoration guard

Backend apply/recover now requires measured persisted PID/start/restart identity. The CLI verifies same-stream endpoint correlation and public health; process and artifact/endpoint guards recheck around exchange/verification. Drift or missing evidence stops without automatic reverse; originals/journal are retained. A stable Backend path restore is PATH_RESTORED_RUNTIME_UNVERIFIED, not operational recovery. Legacy journals missing initial identity are refused. See [implemented handoff](../../docs/deployment/IMPLEMENTED-SAFETY-HANDOFF.md) and [runtime contract decision](../../docs/deployment/RUNTIME-CONTRACT-DECISION.md). Existing mutation examples above remain separate-approval-only; no Production execution is requested by this task.
