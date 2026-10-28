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

## Representative Linux PM2 rehearsal

The Backend required quality job runs an explicit bounded rehearsal after build,
with Node24.18.1 and PM2 7.0.3 installed in temporary test tooling, not as an
application dependency. PM2 CLI operations are restricted to a canonical private
owned temporary HOME/PM2_HOME; no Production or default PM2_HOME is accepted.
The generated test-tool dependency lock and sanitized summary are preserved as
CI artifacts. No raw PM2 list/dump/environment/process logs are uploaded.

The minimal Nest fixture uses the compiled existing configuration and health
modules with synthetic .env and release-local dependencies. It exercises launch,
application-loaded configuration, process/listener/health identity, save, private
daemon termination and resurrection, then startup through the proposed dist
symlink. Failure injection and restoration must verify previous known-good
artifacts, dependency resolution, configuration and health. Existing Linux
atomic-exchange/SIGKILL/recovery tests remain enabled. The test records measured
PM2 declarations rather than manufacturing absent fields.

This validates the pinned PM2 loader/persistence behavior with the real Nest
configuration/health slice; it does not start the full business/worker/database
application or test the VPS systemd unit, Production private settings, host reboot
or actual Production recovery. Full application regression/SQL checks remain
part of ordinary required CI. The rehearsal has no authority to change gates.

## Remaining blockers and minimal operator actions

1. Production strict restart contract remains reviewed=false with null
   instances/PORT/NODE_ENV. Retain those nulls. Review actual launch/persistence
   sources and configuration loading semantics privately before proposing an
   explicit contract change; do not edit/save PM2 to satisfy the validator.
2. Host systemd launch/resurrection identity and saved-source selection remain
   unverified. The following prints only nonsecret service identity/state:

~~~bash
systemctl show pm2-cdnn-deploy --no-pager \
  --property=User,Group,ActiveState,SubState,UnitFileState,MainPID
~~~

   Review the effective unit and any drop-ins locally; return only whether its
   user, PM2_HOME, pinned PM2/Node executable and resurrection source match the
   reviewed design. Do not paste raw unit Environment/ExecStart/ExecStop output.
   Do not enable, start, stop, restart, reload or regenerate the service.
3. Production listener-to-health-responder correlation is still UNVERIFIED.
   Independent listener and health PASS must not be described as exact endpoint
   identity. A separately reviewed read-only correlation method is still needed.
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
