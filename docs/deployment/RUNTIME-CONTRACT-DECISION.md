# Runtime contract equivalence decision

Date: 2026-10-28. Decision: BLOCKED; no equivalent Production restart contract
adopted. runtime-contract.json remains reviewed=false and validateRuntime remains
unchanged. Correlation and process-guard implementation do not waive that gate.

| Layer | Accepted evidence | What it does not establish |
| --- | --- | --- |
| PM2 launch metadata | fork, expected cwd/script/interpreter/options; instances/PORT/NODE_ENV measured null | Explicit launch declarations must not be invented |
| Application config | pinned ConfigModule loads config from cwd; observed app says production on3201 | Which private source/precedence supplies all required values on future startup |
| Runtime observations | online singleton, expected executable, listener and valid health | Same-stream endpoint identity until operator executes the reviewed probe; future restart |
| Persistence | configured systemd identity/PM2_HOME/ExecStart verified; current/saved allowlist matches | Actual primary/backup failover semantics on this host or operational reboot |
| Isolated restart | exact reviewed9f config/health slice, reconstructed original-lock JS dependencies and PM2 serializer/resurrection passed | Full Production application/providers/native modules/database compatibility and private startup inputs |

A defensible future alternative could represent effective fork singleton through
one saved process entry plus observed count, preserve serializer-omitted instances
as null, and bind an explicitly reviewed application configuration source policy
without exposing private values. That is a new source contract requiring its own
proof of equivalent failure/drift behavior. It cannot be created by setting
reviewed=true, accepting health as restart proof, replacing absent PM2 PORT/NODE_ENV
with app health values or silently weakening current validateRuntime.

Precise missing acceptance before adoption:

1. A reviewed explicit policy for application-loaded configuration source location,
   precedence, protected metadata and startup invariants. No Production .env read
   is authorized; operator attestations and synthetic negative tests may support
   the policy, but must not claim unknown private values or exact operational proof.
2. Full saved process-set identity, primary/backup compatibility policy and explicit
   behavior if the primary dump cannot be read or parsed. Configured resurrection
   source is already PASS; it does not determine the runtime fallback outcome.
3. A guarantee that supported interpreter/options/launch path, release-local runtime
   dependencies, application startup failure and recovery semantics are covered by
   that policy, with no mutation needed to make existing metadata fit the policy.
4. Same-stream host correlation observation and ready host plan acceptance remain
   independent prerequisites, even if an alternative contract is later accepted.
5. Actual Production restart/reboot and operational rollback must remain NOT_TESTED
   unless separately approved/performed. A future policy must state whether actual
   operational proof is required before activation; this task does not waive it.

The new process guard strengthens post-exchange safety under the existing outer
flock. It binds PID/start ticks/restart counter and launch metadata to the plan,
checks immediately around exchange/restore, verifies release identity/hashes,
and refuses to call path restoration runtime recovery. Stable process identity
can be checked separately from health so ordinary health failure may restore paths;
unknown/missing process identity or drift instead stops mutations and retains
originals/private journal for review. Strict runtime/activation gates still block
all Production apply. No probe or helper is executed on Production in this task.
