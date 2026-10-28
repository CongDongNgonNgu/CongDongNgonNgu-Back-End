# PM2 persistence and recovery preparation

Date: 2026-10-28. Scope: dev preparation and isolated Linux only.

## Operator evidence accepted

[OPERATOR-EVIDENCE-2026-10-28.json](OPERATOR-EVIDENCE-2026-10-28.json) records the
operator-confirmed five helper hashes for Backend PR #63, observation PASS, zero
current/saved compared launch-metadata differences, Node24.18.1 at /usr/bin/node,
one online fork process, owned port3201 listener and HTTP200 production health.
The comparison excludes resolvedInterpreter/nodeVersion because those are live
process proofs, not saved declarations. PM2 instances/PORT/NODE_ENV remain null.
The original operator results are summarized assertions; Codex did not access VPS.

Nginx syntax PASS, complete dump pipeline0, absent disable_symlinks token and
current worker access PASS support effective policy off. The unrelated protocol
warning and proxy-header hash warnings do not change that successful result.
No Nginx change is requested. The Frontend effective-policy review is now true.
Future worker reads through actual release symlinks and old/new public asset
acceptance remain post-activation checks, not claims about the current layout.

## Persistence semantics and strict restart gate

PM2 save persists manager launch declarations. PM2 resurrect reloads a saved
process list; startup integration is an additional layer. Matching current and
saved allowlisted fields does not prove the saved file was the original launch
source, the current systemd unit selects that PM2_HOME/executable, or that a host
boot will restore the expected process. Never publish raw dump, unit Environment
or arbitrary command-line fields. The production service has not been changed.

A fork process can be observed as a singleton without an explicit instances
declaration. Nest ConfigModule loads application configuration inside its child
process from the configured cwd; that does not add PORT/NODE_ENV declarations to
PM2's manager metadata. Exact behavior is checked by the real PM2 rehearsal, not
filled into Production metadata. Its measured declarations must be reported as
observed; tests must not remove fields to make the fixture resemble the host.

The runtime-contract.json and strict validateRuntime implementation are unchanged.
reviewed=false remains mandatory while the current contract lacks supported
launch declarations. Observation PASS, zero saved differences and a successful
isolated rehearsal do not authorize restart or bootstrap. Any future contract
alternative must be separately reviewed with explicit persistence/configuration
source evidence and equivalent restart guarantees.

### Pinned PM2 7.0.3 implementation review

The [integrity-bound package source review](PM2-7.0.3-SOURCE-REVIEW.json) records
public npm source, independent of Production state. Startup.js intentionally omits
instances from saved declarations (along with transient PM2 identifiers/delay),
and resurrection can fall back to the backup dump if the primary cannot be read
or parsed. Thus a null saved instances field need not mean the observed fork
process is missing; it still does not satisfy the existing strict contract.
Do not manufacture instances=1 or mistake one observed row for a saved declaration.
Host source selection and backup state remain separate review requirements.

ProcessContainerFork.js loads the CommonJS application through Node's module
loader using pm_exec_path. The rehearsal tests the resulting real module path
and release-local dependencies rather than assuming symlink resolution. The
7.0.3 CLI accepts max-restarts but has no min-uptime option. The first isolated
CI run rejected that unsupported test flag before application launch; the test
removes it and records the actual default instead. No Production flag is changed.

God.js also limits unstable-restart counting to a window based on created_at.
A resurrected saved timestamp can be older than that window, so autorestart may
keep retrying a failed startup without reaching errored. A max-restarts setting
is not a health guarantee. The missing-configuration test therefore requires
repeated unavailable health plus measured nonzero child-exit/retry evidence,
then deliberately stops only the isolated daemon, restores the same synthetic
configuration file and requires healthy resurrection. It does not change any
launch option to force a terminal state.

## Representative Linux PM2 rehearsal

The Backend required quality job runs an explicit bounded rehearsal after build,
with Node24.18.1 and PM2 7.0.3 installed in temporary test tooling, not as an
application dependency. PM2 CLI operations are restricted to a canonical private
owned temporary HOME/PM2_HOME; no Production or default PM2_HOME is accepted.
The generated test-tool dependency lock and sanitized summary are preserved as
CI artifacts. No raw PM2 list/dump/environment/process logs are uploaded.

The minimal Nest fixture reuses the reviewed Production9f compiled configuration
and health modules from artifact12735767418, bound to archive SHA-256, complete
distHash and package/lock hashes. The test installs that original dependency lock
into private runner storage with lifecycle scripts disabled; these JavaScript
dependencies are reconstructed, not claimed byte-identical to original
node_modules/native installation outputs. No provenance build is repeated.
Synthetic .env and release-local dependency copies are then used. It exercises launch,
application-loaded configuration, process/listener/health identity, save, private
daemon termination and resurrection, then startup through the proposed dist
symlink. Failure injection and restoration must verify previous known-good
artifacts, dependency resolution, configuration and health. Existing Linux
atomic-exchange/SIGKILL/recovery tests remain enabled. The test records measured
PM2 declarations rather than manufacturing absent fields. The initial CLI launch
measured instances=1; save omits it. The test permits exactly that documented
1-to-null serialization difference, requires all other fields unchanged, then
compares every cold/symlink/recovered declaration to the measured saved baseline.
The Production validator still rejects the undeclared launch fields.

This validates the pinned PM2 loader/persistence behavior with the real Nest
configuration/health slice; it does not start the full business/worker/database
application or test the VPS systemd unit, Production private settings, host reboot
or actual Production recovery. Full application regression/SQL checks remain
part of ordinary required CI. The rehearsal has no authority to change gates.

### Durable baseline input

The reviewed artifact is retained until 2026-11-26. If it becomes unavailable or
its digest differs, required CI fails closed; there is no automatic substitute or
provenance-rebuild fallback. Before that deadline, retain the existing reviewed
archive in approved durable storage and review a durable CI retrieval location
without changing its content identity. Local verified copies already exist in
the parent runtime-provenance-evidence directory. This task creates no storage
account, external publication or Production copy. The sanitized PM2 report and
test-tool lock also have 30-day CI retention; retain them with the source receipt.

## Remaining blockers and minimal operator actions

1. Production strict restart contract remains reviewed=false with null
   instances/PORT/NODE_ENV. Retain those nulls. Review actual launch/persistence
   sources and configuration loading semantics privately before proposing an
   explicit contract change; do not edit/save PM2 to satisfy the validator.
2. Host systemd configuration identity and persistence-source configuration are
   now verified by the operator: cdnn-deploy, enabled/active/running, expected
   PM2_HOME/PIDFile, no drop-ins and pinned pm2 resurrect ExecStart. See
   [host evidence](HOST-SYSTEMD-EVIDENCE-2026-10-28.json). Do not repeat that
   completed inspection unless inputs change. Actual Production restart/reboot
   and backup-dump fallback operation remain untested.
3. Production listener-to-health-responder correlation is still UNVERIFIED.
   Independent listener and health PASS must not be described as exact endpoint
   identity. The [read-only correlation design](ENDPOINT-CORRELATION-DESIGN.md) is prepared;
   implementation is present; mandatory Linux acceptance and separate operator
   execution remain gates. No Production observation has been performed.
4. Operational Production rollback requires an approved concrete plan, fresh
   host provenance/metadata/storage checks, retained verified originals, actual
   atomic-exchange compatibility and restoration/public-asset acceptance.
   Future live symlink traversal is checked only after a separately approved
   activation. No bootstrap CLI apply or Production PM2 action is authorized.

Do not repeat completed helper, Nginx or reproducible-build checks unless their
inputs change. If the five inspection helpers are unchanged by this task, the
accepted PR #63 hash evidence remains applicable to those helper bytes. Preserve
Workspace draft PR #185 and both main revisions.

References: [PM2 save/resurrect and startup](https://pm2.keymetrics.io/docs/usage/startup/),
[PM2 launch fields](https://pm2.keymetrics.io/docs/usage/application-declaration/),
[Nginx symlink default](https://nginx.org/en/docs/http/ngx_http_core_module.html#disable_symlinks).

## Verified Linux result

[PM2-RECOVERY-RESULT.json](PM2-RECOVERY-RESULT.json) binds the successful required
CI run40633202704 and artifact12792577430 to the tested helper revision. All15
rehearsal checks passed, including exact restoration and confirmed daemon/fixture
cleanup. Missing configuration caused exit1 and10 retries while PM2 still reported
online; health correctly remained unavailable. Missing release dependency resolved
through an ancestor and was rejected by release-local acceptance. These are observed
risks to retain in future activation acceptance. The exact known save transformation
was instances1-to-null; all subsequent compared declarations matched saved metadata.
This PASS is limited to the representative Linux configuration/health slice.
Production endpoint correlation, operational systemd restart/reboot and rollback remain
unverified; strict runtime contract and bootstrap readiness remain blocked.

## Host configuration evidence consolidation

The operator verified systemd identity and configured persistence source on
2026-10-28; earlier pending-configuration statements are superseded by
[HOST-SYSTEMD-EVIDENCE-2026-10-28.json](HOST-SYSTEMD-EVIDENCE-2026-10-28.json).
This does not prove the original launch command, actual Production restart or
host reboot. The strict runtime contract remains unchanged and blocked. See
[the concrete bootstrap/rollback acceptance plan](BOOTSTRAP-ROLLBACK-ACCEPTANCE.md).

## Guarded implementation follow-up

The strengthened core refuses path recovery after a restarted/unknown process.
The updated isolated PM2 regression therefore asserts that refusal, then performs
a separately controlled temporary-fixture path exchange and cold resurrection.
That explicit synthetic action does not relax Production helper behavior or
authorize manual recovery there. See IMPLEMENTED-SAFETY-HANDOFF.md. Earlier15-check
PASS remains accepted historical mechanism evidence; changed callers/regressions
are validated by the current required CI, not by repeating provenance reviews.
