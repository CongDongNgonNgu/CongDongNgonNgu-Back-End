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
fresh evidence; this turn did not access the VPS.

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

CURRENT_PATH_ACCESS=PASS. EFFECTIVE_SYMLINK_POLICY=AWAITING_OPERATOR_CONFIRMATION.
The projection omitted nginx's validation result/exit code, config boundaries and
location context, and its anchored filter can miss inline directives. Therefore
absence in that projection alone cannot approve the complete effective policy.
Nginx documents disable_symlinks off as its default; confirm no inherited or
location override applies before approving symlinkTraversalReviewed. No setting
or permission change is proposed. Future .releases ancestors do not exist on the
host; isolated worker tests validate the proposed 711/755/644 layout only.

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
denial and verify restoration and old-asset access. These tests use temporary
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
3. Confirm successful full effective Nginx parse and applicable symlink policy.
   Current worker access passes; future host symlink traversal is not live-tested.
4. Actual PM2 dependency/configuration behavior after path conversion and
   operational rollback require a separately authorized isolated representative
   PM2 rehearsal or Production maintenance/recovery plan. Synthetic Node tests
   do not close that requirement.
5. Fresh read-only plans must match existing provenance, filesystem/env metadata,
   free-space reserve and runtime. Atomic exchange support remains a host gate
   checked only during a separately authorized operation, never inferred from CI.

## Minimal read-only operator actions

Run in the existing authorized host terminal. Review locally and return only
sanitized results. Do not return raw PM2 dump/env, .env, full nginx config or
arbitrary command lines. No helper transfer is authorized by these commands;
use the exact reviewed helpers only if already available in the private
preparation directory.

~~~bash
# Syntax and full include graph; no reload or config change.
sudo nginx -t
# In bash, retain nginx's real status and show only policy tokens (including inline).
set -o pipefail
sudo nginx -T 2>&1 | awk '{line=$0; sub(/#.*/, "", line); while (match(line, /disable_symlinks[[:space:]]+(off|on|if_not_owner)([[:space:]]+from=[^;[:space:]]+)?[[:space:]]*;/)) {print substr(line,RSTART,RLENGTH); line=substr(line,RSTART+RLENGTH)}}'
printf 'NGINX_DUMP_PIPELINE_STATUS=%s\n' "$?"
# As cdnn-deploy; connect-only inspection, no PM2 CLI/daemon startup.
PM2_HOME=/home/cdnn-deploy/.pm2 node /home/cdnn-deploy/bootstrap-preparation/backend/scripts/deploy/check-runtime.cjs --inspect
# Read saved launch metadata in memory and emit only the helper allowlist.
node - <<'NODE'
const fs=require('node:fs');
const {runtimeMetadata}=require('/home/cdnn-deploy/bootstrap-preparation/backend/scripts/deploy/release-checks.cjs');
try {
 const saved=JSON.parse(fs.readFileSync('/home/cdnn-deploy/.pm2/dump.pm2','utf8'));
 console.log(JSON.stringify(runtimeMetadata(saved.map(p=>({name:p.name,pm2_env:p}))),null,2));
} catch {console.log('SAVED_LAUNCH_METADATA=UNAVAILABLE_OR_UNSUPPORTED');process.exitCode=1;}
NODE
~~~

If no symlink directive is emitted with both syntax validation and dump pipeline
status zero, the documented default applies globally. If directives appear,
review their http/server/location inheritance locally and return only this
project's effective policy. No full-config publication is required. Repeating
namei/getfacl/current-path tests is unnecessary unless permissions changed.
Saved dump output is supporting evidence, not proof it was the launch source or
that systemd will restore it. If it also lacks launch fields, report that exact
result; do not edit/save/restart PM2 to make the gate pass. A future independently
reviewed contract can model persisted singleton semantics and app configuration
sources, but must prove restart behavior and preserve strict consumer gates.
