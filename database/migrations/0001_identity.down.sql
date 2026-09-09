BEGIN;

DROP TABLE IF EXISTS oauth_transactions;
DROP TABLE IF EXISTS auth_tokens;
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS provider_accounts;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS users;

DROP TYPE IF EXISTS oauth_transaction_mode;
DROP TYPE IF EXISTS auth_token_purpose;
DROP TYPE IF EXISTS oauth_provider;
DROP TYPE IF EXISTS role_key;
DROP TYPE IF EXISTS user_status;

COMMIT;
