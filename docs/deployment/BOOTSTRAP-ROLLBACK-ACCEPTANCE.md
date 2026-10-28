# Production bootstrap and rollback acceptance plan

Status: PREPARED, NOT AUTHORIZED FOR EXECUTION. Date: 2026-10-28.
Owner: human operator; execution identity cdnn-deploy. This document grants no
Production write, helper transfer, apply/recover, PM2 restart, systemd/Nginx/DB
change, deployment activation or main merge. All Production gates remain false.

## Accepted evidence and exact preservation targets

| Target | Identity / reviewed evidence |
| --- | --- |
| Backend base | /var/www/congdongngonngu/backend |
| Backend baseline SHA | 9f1d6b50dd5d33d312feba0fa23fa4d1e2d46682 |
| Backend dist SHA256 tree | 80a19572e5f1def889327768a8e4a005bfd14069f17d6c1403ba40b7efebe4b4 |
| Backend node_modules SHA256 tree | 5ce1d6f9af1c4aef1b137841f228316c3ed3af358c45501c8679d42b16aea64f |
| Backend package.json | 07b0cd20cfdbd0d95c96386b97a4102074e1d1ac046b264fbfc969c1ac164a43 |
| Backend lock | 821fa821a2f350974d20f88f04d5c94e5f4605c902204aa17c7ad98d0ac35616 |
| Frontend base | /var/www/congdongngonngu/frontend |
| Frontend baseline SHA | 8777545f1d42ffe85e37e2ce5f1d7c8ff9030fea |
| Frontend dist SHA256 tree | 161dd82b465231a9b0592acc916cc25ab12a4a0b6150406820728b4ac6d3fa8b |

Reuse the reviewed REPRODUCTION-RESULT and production-dist-manifest files; no new
provenance build. Five inspection helper hashes and Nginx effective off/current
worker access remain accepted. Systemd configuration identity/source is PASS
per HOST-SYSTEMD-EVIDENCE-2026-10-28.json, not an operational reboot/restart test.
The representative PM2 configuration/health slice passed15 checks. All are
point-in-time evidence; check only invalidated inputs, not repeat experiments.

Preservation must retain complete old dist (including every old frontend hashed
asset and marker absence), original root node_modules, package/lock and original
.env in place. Record .env inode/uid/mode600 without reading/copying its contents.
Do not archive .env, PM2 dump/environment or arbitrary process arguments. Preserve
nonsecret sanitized launch/options plus private local metadata identities for
primary/backup PM2 dumps and systemd fragment; no config write or pm2 save.
Do not rename a launch declaration into invented source provenance.

## Phase A: remaining work without changing Production

1. Consolidate existing operator evidence. Complete; no new systemctl inspection
   needed unless the unit/home/source changes. PID2902322 is the observed daemon
   PID, not an enduring identity or the backend application's PID.
2. Implement and review ENDPOINT-CORRELATION-DESIGN.md in an isolated Linux test,
   including wrong PID, IPv4/mappedIPv6, sharing, denied visibility, close/drift and
   malformed response paths. Only then hand the exact hashed inspector to the
   operator for one bounded loopback GET. No installed helper is changed here.
3. Produce an explicit runtime-contract proposal modeling observed PM2 fork
   singleton and saved serialization separately from application-loaded config.
   Preserve raw nulls and equivalent drift/restart safety guarantees. Existing
   validateRuntime/contract remain unchanged; do not mark reviewed=true to make
   an observation pass. A reviewed equivalent contract is a source-review gate,
   not inherently a reason to restart Production. This task does not adopt it.
4. Review remaining private persistence details locally: whether primary dump is
   readable and backup dump exists/is compatible. Existing current/saved equality
   is accepted; checking backup presence/allowlisted compatibility adds evidence,
   not another PM2 lifecycle command. Do not print raw unit/dump/config values.
   The configured resurrection source is already verified; actual future choice
   on primary failure cannot be asserted from a read-only review.
5. Using separately verified full planning helpers already available in private
   preparation, run read-only inventory/plan with the reviewed evidence. Accepted
   hashes above are expected identities, not permission to silently update them.
   If full helpers are absent, separately review/approve their transfer; five
   inspected runtime files do not authenticate bootstrap/verify/exchange helpers.
   Plan returns BLOCKED while strict runtime contract is blocked; retain that
   honest result. No lock/release/marker/journal is created in read-only mode.
6. Check same-device path metadata, canonical paths, absence of baseline/backup/
   journal collisions, ownership, .env metadata, free space for two artifact copies
   plus512MiB reserve and enough memory/IO budget. Take no repair action. A read
   inventory can be IO-intensive; use one operator-approved bounded observation
   window, stop on load pressure and never stress-test Production.
7. Record currently served project health, redirect/status behavior and exact
   index/JS/CSS URLs plus local/public hashes in private evidence. GET-only,
   no authentication, write API, cache flush, schema query or migration. Existing
   complete asset manifest is reused. Clarify current release-marker absence.
8. Archive the already-reviewed baseline/build and sanitized rehearsal evidence
   in approved durable storage before2026-11-26. No new account or upload is
   performed under this task. Expired/mismatched CI input must fail closed.

Linux filesystem metadata alone cannot prove renameat2 exchange support. An
exchange probe writes scratch paths; it is not a read-only command and is not
allowed now. Existing isolated tests prove mechanism only, not this host mount.

## Implementation gap before operation approval

The current helpers do NOT enforce every acceptance condition below. The runtime
probe is checked before exchange; bootstrap.cjs post-verify checks public health
and assets, without lock-held post-exchange PID/start/restart-counter comparison.
The catch path can automatically restore dist even if a process restarted after
exchange; path restoration is not restoration of loaded process memory.

Before PhaseB can be authorized, a separate independently reviewed implementation
and focused Linux failure tests must enforce post-exchange identity/drift checks
inside the deployment lock and define tested safe restoration/stop semantics for
concurrent exit/restart. If a process restarted, automatic path-only recovery
cannot be labelled operational recovery; retain evidence and require separate
app-scoped recovery approval. No current code is changed or approved as sufficient
by this plan. This implementation gate is in addition to contract/correlation,
not replaced by an operator checklist or public health.

## Phase B: concrete separately approved operation

Entry is BLOCKED until A's contract/correlation/plan gates are accepted. The
operator must approve each app's exact current plan digest and sanitized manifest,
reviewed complete helper revision/hashes, target paths, maintenance window,
observation/stop thresholds, retained-original policy and automatic restore scope.
Do not use a placeholder approval digest. No actual host plan digest exists here.
A ready plan alone is not activation permission or proof of exchange support.

Approve Backend and Frontend separately, serially (Backend first; complete its
acceptance or recovery before Frontend). Keep one scoped deploy lock per helper;
do not touch unrelated services. Approval must explicitly include creating the
release/staging/journal paths, scratch exchange probe, path exchange and immediate
automatic restoration on verification failure. Pause ordinary deploy jobs during
that window only through a separately approved procedure; do not alter gates now.

Expected app-local paths, using each app's exact baseline SHA from the table:

- copied release: .releases/baseline-<baselineSha>/dist
- Backend release also contains copied node_modules, package.json and lock
- retained original: .bootstrap-original-<baselineSha> (original real dist inode)
- journal: .bootstrap-state.json
- live relative link: dist -> .releases/baseline-<baselineSha>/dist

Copy/verify every recorded digest before exchange; resolve all runtime dependencies
inside release/node_modules, reject ancestor fallback, fsync staged content and
journal, preserve original root dependency/package files. Backend release metadata
stays private. Frontend new ancestors711 and dist directories/files755/644; verify
worker traversal later rather than assuming policy alone suffices. Do not copy
Production .env or write a baseline marker before its provenance checks pass.
Probe exchange within the same filesystem before touching live dist; unsupported
probe stops with original intact. No rename/delete fallback and no original prune.

Bootstrap converts byte-equivalent layout; it does not deploy new source or restart
PM2. Existing process PID/start ticks and restart counter must remain unchanged.
Do not add a PM2 restart to this operation to obtain assurance. Any actual restart,
reboot or cold operational recovery is a DIFFERENT approval with a concrete app-only
plan; restarting pm2-cdnn-deploy would affect its managed list and is not authorized.

## Phase C: immediate acceptance and stop conditions

Require all checks after each approved app exchange:

- Actual live symlink target, release .source-sha, retained old inode/content,
  staged hashes and journal agree; no escaped/foreign path or altered artifact.
- Backend dependencies resolve inside the release, original .env inode/uid/mode
  unchanged, PM2 same PID/start/restart counter, HTTP200 exact app identity/env.
  Repeat approved same-stream correlation only if implemented/tested as in A.
- Frontend www-data traverses actual live link and every release ancestor and
  reads index/assets. Public index/oldJS/oldCSS all remain readable, hashes match,
  redirects and intended Production API origin match; truthful marker matches SHA.
- No business smoke writes, migrations, configuration change or service reload.
  Record time and observation window; no universal latency threshold is invented.
  Operator selects numerical health/latency/error/disk thresholds before approval.

Any failed/inconclusive check stops progression. Online alone is insufficient.
New inode/PM2 restart/unknown metadata drift invalidates the approval; do not
refresh the digest automatically or weaken checks to proceed. Preserve diagnostics
privately; output sanitized status/digests only. Systemd config PASS is retained,
actual reboot/restart is still NOT_TESTED after a no-restart bootstrap.

## Phase D: restoration, interruption and rollback acceptance

Ordinary apply failure uses the approved automatic original-dist exchange while
holding the lock. Verify original inode/tree, root dependency/package hashes,
.env metadata, unchanged process identity, health and old asset URLs afterward.
Do not claim restored merely because journal says rolled_back. Preserve partial
release/journal/backup for diagnosis; do not remove originals or clean evidence.

After interruption: read-only recovery classification first. If original is live,
verify it directly. If reviewed release link is live and retained original is
intact, prepare a fresh recovery digest; manual/post-crash recovery needs separate
approval. If baseline/backup changed, endpoints ambiguous, process restarted, or
inode/hash differs: STOP for operator review. No rm/mv heuristic or auto repair.

If the process restarted under the converted layout, restoring the path alone
may leave an already-loaded process using release code/dependencies. Existing
recover helper does not restore process memory or restart PM2. Declare operational
recovery BLOCKED; propose a separately approved app-scoped restart/health plan
rather than silently invoking the daemon service. Same applies if current process
can no longer serve healthy requests. Database/schema rollback is never assumed.

A successful isolated rehearsal plus host config PASS means recovery design is
supported, not Production rollback tested. Operational rollback status remains
NOT_EXECUTED until a separately approved actual event/rehearsal proves it. Retain
original artifacts until explicit retirement approval; never prune on task close.

## Approval boundary for this task

No Production mutation is required to consolidate evidence or finish these designs.
Do not ask for blanket activation approval now: no reviewed equivalent runtime
contract, completed host correlation or ready host plan digest is available.
If further work reaches an unavoidable mutation/restart, stop and request approval
of its exact paths/command/digest and restoration scope before executing it.
