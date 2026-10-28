# Read-only endpoint connection correlation design

Status: DESIGN_REVIEWED_NOT_IMPLEMENTED_NOT_EXECUTED. Date: 2026-10-28.
Current Production endpoint correlation: UNVERIFIED. This document is not an
executable probe, a helper transfer request or an activation/restart approval.
Do not replace the existing helper or change its strict gate under this task.

## Why a separate listener and HTTP response are insufficient

An owned tcp6 listener3201 plus an independent IPv4 localhost200 can refer to
different endpoints. /proc/PID/net describes its network namespace, not exclusively
that PID. A listening inode proves binding ownership but not which accepted
connection carried a specific health response. A fresh curl and ss/lsof snapshot
on different connections does not close that gap. Do not read environ/cmdline,
attach strace/eBPF/ptrace or change app instrumentation to claim correlation.

## Proposed one-stream probe

A later implementation must be independently reviewed and tested in isolated
Linux, then hashed for operator execution. It uses native Node built-ins, no npm
install, no PM2 CLI/API startup path, no file or configuration writes. The ordinary
health GET can increment existing counters or access logs; no logging is disabled.

1. Select the application PID from the already hash-verified connect-only PM2
   inspector. SYSTEMD_MAIN_PID2902322 is the PM2 daemon, not the app. Record app
   PID/start ticks, expected executable/cwd and network namespace; require stable
   identity and expected UID. Never reuse the historical application PID blindly.
2. Open exactly one native net.Socket to127.0.0.1:3201 in the same network
   namespace, no DNS/proxy/pool/redirect/TLS negotiation. Hold it without sending
   bytes while polling briefly for the server's accepted connection. Record
   actual local/remote address and ephemeral source port from that socket.
3. Parse namespace tcp and tcp6 tables correctly (including kernel word byte
   order and IPv4-mappedIPv6 normalization). Find exactly one ESTABLISHED server
   row reversing that exact client4-tuple. Require a nonzero accepted inode and
   find socket:[inode] in the reviewed application's fd table. Distinguish the
   accepted inode from the LISTEN inode, and verify the client fd/tuple too.
4. For exclusive-holder assurance, inspect other visible process fd tables for
   the same accepted inode, using existing permissions. Any unrelated holder or
   incomplete visibility/permission failure yields UNVERIFIED, not presumed
   exclusivity. No escalation, permission change, kill or interference with other
   services. If full visibility is unavailable, report only nonexclusive ownership
   observations and retain the correlation gate as UNVERIFIED.
5. Recheck app identity, tuple and accepted inode immediately before writing
   exactly GET /api/v1/health HTTP/1.1 on the same socket, fixed Host127.0.0.1:3201,
   Connection:keep-alive and Accept:application/json. No auth/cookies/request body.
6. Read one bounded response from that same stream. Require200 and exact reviewed
   success/service/status/environment identity. Preserve actual HTTP status if
   JSON parsing fails. Do not print arbitrary headers/body/error text.
   Suggested limits:5s whole operation,16KiB headers,64KiB body. Use vetted HTTP
   framing or a deliberately strict parser accepting one valid Content-Length,
   no Transfer-Encoding/compression, no conflicting lengths, extra response or
   trailing payload. Unsupported framing is UNVERIFIED, not a parsing guess.
7. After the complete response but before closing, recheck exact accepted inode,
  4-tuple, PID/start/exe/cwd/namespace and required exclusive-holder observations.
   Socket closes early, inode disappears/reuses, identities drift, data is
   ambiguous or time expires: UNVERIFIED. Always close only the probe's socket.
8. Emit only status booleans, bounded timestamps, app PID/start identity and
   allowlisted health identity; inode/tuple may stay in private in-memory evidence.
   Never dump all socket tables/fd lists, process environment or raw health data.

## Defensible result and limits

A completed passing probe may report PASS_CONNECTION_OWNERSHIP_CORRELATED with
scope: same held connection, same stable application, accepted inode owned at
before/after snapshots, trusted ordinary host. It does NOT prove absolute
code-level causality, absence of privileged interference, transient SCM_RIGHTS
transfers between snapshots or application-level upstream proxying. Shared or
transferred accepted descriptors require UNVERIFIED exclusive-responder status.
SO_REUSEPORT listener sharing alone does not invalidate an exact accepted-stream
match; it does make a listener-only inference insufficient.

No correlation result authorizes bootstrap/restart or fills PM2 null declarations.
The application need not expose a new PID endpoint. Existing isolated diagnostics
are not available on Production and must not be activated there for this check.

## Implementation acceptance before operator command

Required negative/positive Linux cases: IPv4, mappedIPv6, wrong PID, parallel
client, shared listener, shared accepted descriptor, PID/start/exe/cwd drift,
namespace mismatch, denied/incomplete visibility, fd disappearance/transfer,
server closes early, unavailable response, malformedJSON200/503, oversized or
ambiguous framing, timeout. Test with synthetic processes only; assert no helper
lifecycle/Production path/environment access and no private-output leakage.
A passing design review is not these execution tests; do not claim them done.

NEXT_OPERATOR_ACTION for this item: none executable yet. First implement/test and
review a standalone probe in a separate authorized source task, then hand its
exact SHA and one read-only invocation to the operator. Do not run an unreviewed
one-liner or repeat already accepted listener/health observations as correlation.

References: [Linux proc network namespace data](https://man7.org/linux/man-pages/man5/proc_pid_net.5.html),
[Socket inode fd links](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html),
[Node socket endpoint properties](https://nodejs.org/docs/latest-v24.x/api/net.html#socketlocalport).
