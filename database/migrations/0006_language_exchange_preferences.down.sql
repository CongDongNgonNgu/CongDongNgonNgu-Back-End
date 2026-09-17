BEGIN;

DROP TABLE IF EXISTS language_exchange_interests;
DROP TABLE IF EXISTS language_exchange_goals;
DROP TABLE IF EXISTS language_exchange_partner_levels;
DROP TABLE IF EXISTS language_exchange_languages;
DROP TABLE IF EXISTS language_exchange_preferences;

DROP INDEX IF EXISTS language_exchange_interests_match_idx;
DROP INDEX IF EXISTS language_exchange_goals_match_idx;
DROP INDEX IF EXISTS language_exchange_partner_levels_match_idx;
DROP INDEX IF EXISTS language_exchange_languages_match_idx;
DROP INDEX IF EXISTS language_exchange_languages_user_idx;
DROP INDEX IF EXISTS language_exchange_discovery_idx;
DROP INDEX IF EXISTS user_languages_user_id_id_idx;

DROP TYPE IF EXISTS exchange_contact_permission;
DROP TYPE IF EXISTS exchange_visibility_mode;
DROP TYPE IF EXISTS exchange_language_direction;

COMMIT;
