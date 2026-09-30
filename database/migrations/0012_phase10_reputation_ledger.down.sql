BEGIN;

DROP INDEX IF EXISTS reputation_ledger_source_idx;
DROP INDEX IF EXISTS reputation_ledger_user_balance_idx;
DROP INDEX IF EXISTS reputation_ledger_reversal_unique_idx;
DROP TABLE IF EXISTS reputation_ledger_entries;

DROP TYPE IF EXISTS reputation_source_type;
DROP TYPE IF EXISTS reputation_system;

COMMIT;
