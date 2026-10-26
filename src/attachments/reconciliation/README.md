# Bounded orphan observation only

AttachmentOrphanDetector.inspectNextPage reads one approved storage adapter namespace page, at most100 entries, then obtains read-only exact database manifest classifications. Concurrent calls share the same in-flight page. Provider/database/alert failure leaves its private cursor unchanged; a completed scan resets to the namespace start on the next call. Cursors remain internal and bounded to the adapter's2048character contract. Scheduling, cooldown and restart composition are separate.

The detector can only call listOwnedPrefix. It cannot read private bytes, HEAD, PUT, delete, adopt, settle producers, release quota or grant access. The repository uses an unlocked bounded SELECT; classifications are observations, never cleanup claims or authorization. Unknown valid-looking UUIDs and mismatched locator/size never become ownership authority. Backup namespace exclusion remains the storage adapter's responsibility.

TRACKED and CLEANUP_PENDING are counted. Unknown, unrecognized, uncertain, retired, mismatched, never-started and inconsistent objects emit aggregate allowlisted diagnostics with random event UUIDs and counts only. Raw object keys, locators, account/attachment identifiers, provider cursors, private URLs and underlying error messages never enter reports or alerts. Alert failure retries the page and can repeat diagnostics.

An uncertain object remains uncertain. Positive-provider full-checksum recovery after proven actual producer quiescence, negative-HEAD limitations, durable cleanup, reservation release and retention purge are not implemented by this detection slice. There is no blind boot/expiry lease reset and no deletion of unknown objects.

Tests use deterministic metadata structure, owned random UUID fixtures and synthetic provider listings. SQL classification executes inside READ ONLY transactions in disposable schemas on the approved TEST target. No real provider requests, real user media, shared schema migration, deployment, cleanup success or runtime leak count is claimed.

Adjacent modules implement positive PUT recovery with exact original supervision and durable identity checks, and separately guarded terminal retention under `../retention`. The application composition remains disabled by default. Their source tests do not grant this read-only detector deletion authority or establish deployed acceptance. Unknown read/HEAD transport closure and lost process-local authority retain producer/deletion debt; no restart or negative observation resets it.

