# Implemented correlation and bootstrap safety - operator handoff

Date: 2026-10-28. This is preparation on dev only. No Production probe, helper
transfer, bootstrap apply/recover or PM2/systemd lifecycle action is authorized
or executed. Main and both literal false Production gates are preserved.

## Source identity and accepted evidence

REVIEWED-SAFETY-HELPERS.json binds exact Git blob hashes to the implementation
commit for this repository. The manifest is not an installed-VPS observation.
The earlier five-file1477638 helper proof remains historical evidence only:
check-runtime now has a runtime-process dependency and restart-counter checks.
Do not run a new probe from an old/mixed preparation directory or reuse the old
five-file hash gate as authentication for this new implementation.

Reuse accepted provenance, systemd configuration, effective Nginx policy and
isolated PM2 evidence. No new provenance experiment or host review is required
unless inputs changed. The strengthened core/CLI requires updated isolated
regressions; configured required CI may run existing tests automatically.

## Read-only probe trust boundary and future invocation

The endpoint-correlation core uses Node built-ins only. Its fixed --inspect CLI
selects the current app PID/start through the sibling connect-only check-runtime
inspector, whose existing installed PM2 7.0.3 transport is read in memory; no
package is installed on VPS and no PM2 lifecycle/API startup helper is invoked.
The existing RPC inspector requires cdnn-deploy, expected PM2_HOME/service/socket
and fixed allowlisted metadata. An arbitrary supplied PID is not a CLI option.

The probe holds one127.0.0.1:3201 stream, verifies exact accepted/client inode and
reverse tuple, owning PID/start/exe/cwd/namespace and exclusive fd ownership before
and after one strict bounded health response. It checks threads and rechecks
ownership after the full process scan. Denied or hidden process visibility,
shared/transferred accepted fds, drift, close, malformed framing/health or timeout
fail closed. Scope remains trusted-host snapshot correlation, not proof against
transient privileged interference or future restart.

Normal cdnn-deploy permissions may prevent reading root/other-service fd tables.
That produces UNVERIFIED; do not add sudo, capabilities, ptrace, permission changes,
root execution or an incomplete-visibility bypass to make Production pass. The
privileged CI suite has isolated synthetic processes and proves the mechanism,
not deploy-user visibility on the actual host. Production result remains UNVERIFIED
until a separately requested read-only operator observation succeeds.

Future invocation template ONLY, not a request to execute now. First separately
review/approve transfer of the inspection dependency set into a canonical private
versioned preparation directory and verify every manifest hash from one revision.
Use trusted SSH/host keys and no credential-bearing URL. Never transfer .env,
node_modules, whole Workspace or mutating helpers merely to run this probe.
Set INSPECTION_DIR to the verified directory; do not guess a placeholder path.

~~~bash
# NOT AUTHORIZED TO EXECUTE ON PRODUCTION IN THIS TASK.
sudo -u cdnn-deploy -H env -u NODE_OPTIONS -u NODE_PATH \
  PATH=/usr/local/bin:/usr/bin:/bin PM2_HOME=/home/cdnn-deploy/.pm2 \
  /usr/bin/node "$INSPECTION_DIR/endpoint-correlation.cjs" --inspect
~~~

The sudo wrapper selects the established deploy identity, never root for the
probe. Exit0 means PASS_CONNECTION_OWNERSHIP_CORRELATED; exit2 means UNVERIFIED.
Return sanitized JSON only. Do not print raw PM2 dump, environment, fd/socket table,
health body, .env or arbitrary errors. No lifecycle fallback is permitted.

Inspection-only dependency allowlist: endpoint-correlation.cjs, check-runtime.cjs,
runtime-process.cjs, runtime-proof.cjs, pm2-socket.cjs, release-checks.cjs and
runtime-contract.json. The full bootstrap manifest additionally authenticates
mutating code, but transferring/authenticating it does not authorize its execution.

## Strengthened lock-held bootstrap behavior

bootstrap.sh still holds the deployment flock for apply/recover; no activation
caller is enabled. CLI receives process identity from fresh connect-only captures,
including actual PM2 restart counter and stable launch metadata. The Backend
plan still blocks unless the existing strict runtime validator passes; raw null
instances/PORT/NODE_ENV are not changed or supplied by health observations.

Backend apply requires processGuard plus verification callback; the initial
PID/start/restart tuple must equal the plan runtime evidence and is persisted in
the private journal. Before/after exchange, after expensive artifact hashing,
after health/correlation and before acceptance, it checks process identity and
release .source-sha/dist/dependency/package/lock/root-env metadata and live/retained
original endpoints. The Backend CLI callback requires probe exit0/exactPASS and
public verification; core checks the process again afterward while lock held.
Frontend has no Backend process guard; it enforces artifact/source/live/backup
integrity and public assets. No frontend config change or service restart occurs.

Stable ordinary health/correlation failure may reverse paths, recheck artifacts
and identity, and classify PATH_RESTORED_RUNTIME_UNVERIFIED for Backend (PATH_RESTORED
for static Frontend). This is not restored endpoint acceptance or operational
rollback proof. Operator-approved post-restoration health/asset acceptance is
still required. No automatic PM2 restart or systemd action exists.

Process exit/PID/start/restart drift or unknown identity prevents automatic reverse,
retains original/release/private journal and classifies STOPPED_RUNTIME_REVIEW_REQUIRED.
Corrupt/mismatched artifacts or ambiguous endpoints also stop. Partial reverse
followed by drift becomes recovery_stopped; it cannot be reported as verified
rollback. Recovery requires the persisted original process identity; legacy Backend
journals lacking it are refused for manual review. No original baseline is deleted.

--recovery-plan is read-only endpoint classification. --verify is a separate
read-only observation, not proof the exchange was lock-held or approval to deploy.
Manual/post-crash --recover still requires a freshly reviewed digest and separate
approval. Restoring a path after a process restarted cannot restore process memory.

## Runtime contract decision and remaining gates

RUNTIME-CONTRACT-DECISION.md retains BLOCKED. No equivalent contract is adopted:
missing private configuration-source guarantees and full primary/backup/startup
policy cannot be inferred from observed health or serializer omission alone.
The source implementation of validateRuntime and reviewed=false contract remain
unchanged. A successful probe or isolated guard tests do not override that decision.

Remaining before any Production bootstrap: reviewed equivalent runtime contract if
one is justified; successful permitted host correlation; actual helper/version
transfer verification if authorized; fresh read-only plan/inventory/storage checks;
host exchange support tested only in a separately approved operation; concrete
app/digest/window/restore approval; future live worker/public-asset acceptance.
Actual Production restart/reboot and operational rollback remain NOT_TESTED.

## Preservation and operational recovery

BOOTSTRAP-ROLLBACK-ACCEPTANCE.md is the concrete preservation plan. Keep original
dist inode and full old assets, root dependencies/package/lock and original .env
inode/uid/mode in place. No .env content is read/copied by inventory. Retain journals
and failed staging; never prune original artifacts without a new retirement approval.
If process identity drifts, stop and preserve; a future app-scoped restart/recovery
plan must separately name commands, ownership/source identities, health/correlation,
rollback criteria and approval. Do not restart the daemon service to obtain proof.

Existing reviewed archives are already downloaded locally in the parent
runtime-provenance-evidence directory. Verify their recorded hashes and retain
approved durable copies and sanitized test evidence before2026-11-26. This task
performs no external upload/account creation or private Production-data retention.
An unavailable/expired pinned CI artifact remains fail closed, never auto-substituted.
