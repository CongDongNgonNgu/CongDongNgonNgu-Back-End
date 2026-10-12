# Direct-message notifications

Migration `0036_phase26_message_notifications.sql` adds the generic
`DIRECT_MESSAGE` notification type and durable queue progress. Apply it before
starting compatible message producers and notification workers.

Message sends and advancing conversation reads increment the recipient's queue
generation in their existing transaction. Each increment resets retry delay;
processed generations remain monotonic. Notification read state is independent
of the conversation's authoritative read position.

The worker locks accounts, the canonical connection pair, the conversation,
then the queue row. It materializes a notification and acknowledges the locked
generation in one transaction. The first incoming unread message identifies a
coalesced episode. Replays preserve notification READ state and produce no
duplicate live hint. Failures retain work with bounded retry delay, and live
hints are published only after commit. REST remains the recovery path.

REST, unread counts and SSE independently check current participant eligibility,
connection, blocks, preferences and first-unread identity. Notifications carry
only a generic system actor and conversation navigation: no message text,
context metadata or partner profile. Memory-only notification applications
start no PostgreSQL queue worker and deny direct-message projections.

Stop incompatible producers and workers before downgrade. The down migration
takes exclusive table locks and refuses retained direct-message notifications
or pending generations; it never deletes them to force rollback. Its lock order
is not a supported concurrent rollback strategy for a running worker.

The isolated SQL tests cover the complete ordered migration baseline, guarded
downgrade, concurrent workers, coalescing, transaction rollback, retry fairness,
partial reads, current revocation and separate SSE preferences. They do not
replace the Phase26.006 deployed multi-account browser acceptance.
