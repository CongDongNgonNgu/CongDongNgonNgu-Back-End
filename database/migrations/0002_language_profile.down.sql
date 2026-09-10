BEGIN;

DROP TABLE IF EXISTS user_availability;
DROP TABLE IF EXISTS user_profile_interests;
DROP TABLE IF EXISTS user_profile_skills;
DROP TABLE IF EXISTS user_learning_goals;
DROP TABLE IF EXISTS user_languages;
DROP TABLE IF EXISTS user_profiles;
DROP TABLE IF EXISTS languages;

DROP TYPE IF EXISTS profile_skill;
DROP TYPE IF EXISTS language_visibility;
DROP TYPE IF EXISTS assessed_language_proficiency;
DROP TYPE IF EXISTS declared_language_proficiency;
DROP TYPE IF EXISTS language_direction;

COMMIT;
