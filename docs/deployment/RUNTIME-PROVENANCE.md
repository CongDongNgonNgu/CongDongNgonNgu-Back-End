# Runtime proof and artifact provenance investigation

Status: RUNTIME_CONTRACT_STATUS=BLOCKED; BACKEND_PROVENANCE=BLOCKED;
FRONTEND_PROVENANCE=BLOCKED; BOOTSTRAP_READINESS=BLOCKED.
This is preparation on dev only. Production activation remains locked.

## Observations on 2026-10-27

Direct read-only SSH succeeded using the existing cdnn-deploy identity before the
operator's follow-up restricted further VPS evidence gathering to operator output.
No helper was transferred, no Production build/install was run, and no filesystem,
service, environment or database mutation was performed. Further VPS checks below
are operator actions. Source SHA and clean Git status are not artifact provenance.

Backend main: 9f1d6b50dd5d33d312feba0fa23fa4d1e2d46682.
Frontend main: 8777545f1d42ffe85e37e2ce5f1d7c8ff9030fea.
Read-only ls-remote independently matched both supplied revisions.
Node /usr/bin/node v24.18.1 and npm 11.16.0 were measured on the host; these
are current runtime/tool versions, not proven original build-tool versions.

The existing PM2 inspector reproduced instances=null, port=null, environment=null.
It reads PM2 getMonitorData fields only. Missing PM2 fields do not prove missing
application configuration. Pinned Nest ConfigModule.forRoot loads configuration
inside the application; the health controller returns validated app.environment.
This explains a possible source of the metadata/application difference, without
claiming which private configuration file supplied a value.

Independent /proc evidence found one accessible /usr/bin/node process with the
application cwd: PID 2902336, start ticks 769181042. Its owned tcp6 LISTEN socket
inode 371070083 maps to port 3201. A direct localhost request to
http://127.0.0.1:3201/api/v1/health returned 200, status=ok,
service=congdongngonngu-backend, environment=production. Process titles can contain
spaces: parse /proc/PID/stat after its final closing parenthesis; whitespace-only
field splitting is invalid. The new diagnostic has regression coverage for this.
These observations establish the measured listener and health identity, not an
immutable PM2 launch declaration or a future restart test. A PID-owned IPv6
listener and a separate IPv4 localhost health response do not alone prove that
the request reached that exact PID; address-family/reuse-port correlation remains
an explicit limitation. Supplementary evidence cannot complete the contract.

PM2 options observed: autorestart=true, watch=false, max_memory_restart=1073741824,
treekill=true; kill_timeout, listen_timeout, restart_delay,
exp_backoff_restart_delay, cron_restart, wait_ready, stop_exit_codes and
shutdown_with_message were null. Arguments, node arguments and NODE_OPTIONS were
sanitized empty arrays. Resolved interpreter=/usr/bin/node, Node=24.18.1.
The contract remains reviewed=false. Its complete reviewed options/arguments and
explicit treatment of absent instance/launch environment metadata are still
required. Supplementary socket/health evidence never fills PM2 fields or clears
that gate. Bootstrap retains all existing provenance/runtime/rollback gates.

## Artifact observations

Read-only bootstrap-core.inventory at 2026-10-27T12:53:21Z returned:

| Artifact | SHA-256 |
| --- | --- |
| Backend dist | 80a19572e5f1def889327768a8e4a005bfd14069f17d6c1403ba40b7efebe4b4 |
| Backend node_modules | 5ce1d6f9af1c4aef1b137841f228316c3ed3af358c45501c8679d42b16aea64f |
| Backend package.json | 07b0cd20cfdbd0d95c96386b97a4102074e1d1ac046b264fbfc969c1ac164a43 |
| Backend package-lock.json | 821fa821a2f350974d20f88f04d5c94e5f4605c902204aa17c7ad98d0ac35616 |
| Frontend dist | 161dd82b465231a9b0592acc916cc25ab12a4a0b6150406820728b4ac6d3fa8b |

The original request's modules digest had 58 characters; the 64-character value
above was independently recaptured and subsequently confirmed by the operator.
Pinned Backend package and lock Git blob hashes match these two metadata hashes.
The adjacent production-dist-manifest.json preserves exact sorted tree records
(paths, types, sizes, hashes only), digest-bound by the report helper. It records
observed bytes, not historical source attribution.

The separate artifact-reproduction workflow builds the exact pinned source twice
on independent Ubuntu24.04 runners with Node24.18.1/npm11.16.0, locked dependencies,
npm ci --include=dev and npm run build. Frontend uses only the nonsecret Production
VITE_API_BASE_URL. No Production .env is used. Reports use bootstrap-core.tree,
compare all required hashes and list Production-only/build-only/changed paths.
Original build commands, install flags, tool versions and remaining settings are
unverified; the report never automatically claims provenance or approves bootstrap.
Per-file retained historical assets require their own authenticated origin. An
unexplained union of old assets and a new build is not reproducible provenance.

## Nginx requirements and observed modes

Readable nginx.conf declares user www-data; the cdnn site root is unchanged at
/var/www/congdongngonngu/frontend/dist. No explicit disable_symlinks was found in
the inspected main/site files. The complete effective include graph and worker
identity read tests still need operator evidence; there is no sudo authorization
for these checks under cdnn-deploy. Do not infer full policy from partial files.
Observed modes: /var and /var/www 755 root-owned; application parent and frontend
root 755 uid/gid1001; live dist 775; index.html 664. .releases does not exist.
Current public serving demonstrates current-path access, not future symlink access.
No chmod was issued. A future reviewed layout needs worker traversal through every
ancestor and read access to files; private Backend paths must remain private.

Operator read-only commands (run in the existing authorized terminal):

```bash
sudo nginx -T 2>&1 | awk '/^[[:space:]]*(user|disable_symlinks|root|server_name)[[:space:]]/ {print}'
namei -l /var/www/congdongngonngu/frontend/dist/index.html
getfacl -p /var/www/congdongngonngu/frontend /var/www/congdongngonngu/frontend/dist
sudo -u www-data test -x /var/www/congdongngonngu/frontend && echo frontend-traverse=PASS
sudo -u www-data test -r /var/www/congdongngonngu/frontend/dist/index.html && echo index-read=PASS
```

Return only this project's applicable server/root/worker/symlink policy, modes/ACLs
and PASS/FAIL outputs; do not return raw environment, process command lines or
credentials. Do not run a PM2 CLI command that could spawn an absent daemon.

## Separate migration design: not authorized for execution

Design safety review: existing bootstrap cannot adopt unauthenticated old bytes as
a source-SHA baseline. Keep it blocked. Original build evidence is not located;
use a separately reviewed migration implementation if exact provenance fails.
Operator approval=PENDING; operational recovery validation=PENDING.

1. Produce a new known-good release from an explicitly reviewed immutable source
   SHA in an isolated Linux build. Pin toolchain/container digest, install/build
   flags and nonsecret configuration; verify two independent builds, audits,
   tests, dependency ABI and exact manifests. Bind release source/artifact hashes.
2. Preserve current running dist, dependencies, package/lock and runtime launch
   declaration under a content-addressed observed-artifact identity. Verify
   preserved content, ownership/modes and storage reserve. Preserve Production
   .env in place; never archive its contents. Do not write a fabricated .source-sha
   or frontend source marker for the unproven original. Retain historical assets.
3. Design recovery to restore the original content-addressed artifact and launch
   configuration without relying on an unknown original SHA. Current release.sh
   expects previous .source-sha and a frontend marker, so it is NOT a valid fallback
   for this case. A separate reviewed implementation and Linux fault/recovery tests
   must cover crash boundaries, partial activation, failed health checks, dependency
   resolution and original marker absence before any live migration is approved.
4. Validate recovery in a representative isolated environment with synthetic
   configuration/database; verify restored content hashes, launch/listener and old
   asset URLs. Existing Linux bootstrap tests are mechanism evidence only. They do
   not establish operational Production rollback or restart safety.
5. Obtain explicit operator approval of the concrete release, preservation manifest,
   maintenance/activation plan and tested recovery procedure. Any PM2 restart or
   serving-path switch requires that separate approval. Keep Nginx configuration
   unchanged unless separately reviewed and approved. No automated database
   migrations; inspect schema compatibility read-only and stop on incompatibility.
6. After an approved future activation, verify health, PID/configuration, public
   asset URLs and exact artifact identities; retain the original until separately
   authorized retirement. This investigation executes none of these steps on VPS.

References: [PM2 options](https://pm2.keymetrics.io/docs/usage/application-declaration/),
[Nest configuration](https://docs.nestjs.com/techniques/configuration),
[Nginx symlink directive](https://nginx.org/en/docs/http/ngx_http_core_module.html#disable_symlinks).
