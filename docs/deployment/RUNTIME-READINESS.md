# Runtime contract and bootstrap readiness ? 2026-10-28

Production remains locked. No VPS mutation, PM2 restart, Nginx/database change,
bootstrap CLI apply, main merge or Production activation is authorized by this work.
Workspace draft PR #185 is outside this change.

## Decision and acceptance

Keep three evidence layers distinct:

| Layer | Reviewed evidence | Limit |
| --- | --- | --- |
| PM2 launch metadata | cwd/script, node interpreter, fork mode, sanitized arguments/options | instances, PORT and NODE_ENV remain null |
| Kernel process | Node 24.18.1 at /usr/bin/node, cwd, PID/start identity and owned port-3201 listener | one observed online row is not a persisted instances declaration |
| Application | independent localhost HTTP 200, exact backend identity and production health | application defaults/configuration do not fill PM2 launch fields |

Backend observationReviewed=true approves only the recorded sanitized baseline.
At each inspection, assessRuntime compares every recorded metadata field and requires
one online PM2 row, a matching PID/start identity, expected cwd/executable/listener
and successful application health. It reports observationScope and
endpointCorrelation=UNVERIFIED: an owned tcp6 listener and separate IPv4 request
are not proof that the request reached that PID. Historical observations are not
fresh evidence; the operator has now confirmed five pinned helper hashes, observation PASS and zero current/saved launch-metadata differences. Codex did not access the VPS.

The strict restart validator remains unchanged. reviewed=false, null launch fields,
unsupported arguments/options, drift or missing evidence keep runtime.reviewed=false.
Bootstrap and release consumers still require that strict gate. Observation PASS
cannot authorize apply or restart. Restart configuration must be reviewed from the
actual launch/persistence source; no instance/default/env value is fabricated.
There is no reviewed alternative restart contract yet. Read-only evidence can
clarify declarations but cannot prove an actual future Production restart.

## Nginx operator evidence

The operator supplied an nginx -T directive projection declaring worker www-data,
project root /var/www/congdongngonngu/frontend/dist and relevant domain names.
No disable_symlinks directive appeared. namei shows canonical directories with
755 ancestors, dist 775 and index 664, owned by cdnn-deploy below /var/www.
FRONTEND_TRAVERSAL=PASS and NGINX_READ=PASS were obtained as www-data.
getfacl was unavailable; do not install it merely for this task. Direct access
checks establish effective current access despite unavailable ACL detail.

CURRENT_PATH_ACCESS=PASS. EFFECTIVE_SYMLINK_POLICY=VERIFIED_OFF.
On 2026-10-28 the operator confirmed nginx -t PASS, complete dump pipeline
status 0 and no disable_symlinks token. This supports the documented global
default off and closes the earlier projection/parse-status limitation. The
reported protocol-option and proxy-header hash warnings do not invalidate the
successful syntax test; the protocol warning concerns an unrelated domain. No
Nginx configuration change is requested.

Effective policy review is separate from future live release traversal. No
Production path conversion has occurred; worker traversal/read access through
actual .releases ancestors and public old/new assets must be verified after any
separately approved activation. Current-path access is not that future check.
The [operator evidence](OPERATOR-EVIDENCE-2026-10-28.json) preserves the exact
reported scope, nullable launch declarations and unverified endpoint identity.

## Provenance and recovery evidence

Reuse the already reviewed REPRODUCTION-RESULT.json and
bootstrap-evidence.provenance.json. Backend PR #62 and Frontend PRs #61/#62
established exact source reproduction of all observed dist/dependency/package/lock
bytes. Historical build commands remain NOT_ESTABLISHED. No fresh provenance
experiment is needed for this runtime-only change; ordinary configured CI may
still trigger the existing reproduction workflow automatically.

Existing Linux tests retain copy/exchange/health/fsync/runtime-drift failures,
SIGKILL at journal/prepared/exchanged/verified boundaries and reverse exchange,
stale approvals, tamper/path escape refusal and lock contention.
bootstrap-runtime.node-spec.cjs adds synthetic Node cwd-based configuration,
release-local dependency resolution, live health before/during/after exchange,
new process launch through the symlink, original process survival, complete
restored hashes/env metadata and original marker absence. Frontend tests execute
reads as www-data through the actual proposed symlink layout, inject traversal
denial and verify restoration and old-asset access. Those existing tests use temporary
paths, synthetic configuration and ephemeral loopback ports only. No PM2 daemon,
Production database or Production secret is used. They are Linux mechanism and
runtime-assumption evidence, not a real PM2 launch/restart or Production recovery
rehearsal. Linux results must come from green CI; Windows skips are not PASS.

## Remaining blockers

1. PM2 launch instances/PORT/NODE_ENV are undeclared in observed metadata. A
   sanitized persistence/declaration review and an explicitly reviewed restart
   contract are required; the current strict gate remains blocked.
2. Exact listener-to-health responder correlation remains unverified. Current
   independent observations must not be described as complete endpoint identity.
3. Effective Nginx syntax/symlink policy and current worker access are verified.
   Future live release-symlink traversal and public asset acceptance remain a
   separate post-activation requirement.
4. The authorized representative PM2 rehearsal is enforced by Backend quality CI.
   Its configuration/health-slice result is separate from the unverified VPS
   systemd startup and actual Production operational rollback requirements.
5. Fresh read-only plans must match existing provenance, filesystem/env metadata,
   free-space reserve and runtime. Atomic exchange support remains a host gate
   checked only during a separately authorized operation, never inferred from CI.

## Operator evidence request satisfied

The earlier helper/current/saved/Nginx requests are satisfied by the operator
evidence dated 2026-10-28. Do not rerun them without changed inputs. Remaining
host persistence/correlation and post-activation requirements are listed in
[PM2-PERSISTENCE-RECOVERY.md](PM2-PERSISTENCE-RECOVERY.md).

## PM2 persistence and representative rehearsal follow-up

See [PM2-PERSISTENCE-RECOVERY.md](PM2-PERSISTENCE-RECOVERY.md). Current/saved
metadata equality verifies the compared allowlist, not the host systemd unit,
launch source or resurrection behavior. PM2 instances/PORT/NODE_ENV remain null;
the application reports production after loading its own configuration. Neither
that health response nor observation PASS may approve restart. The strict
runtime contract remains reviewed=false.
