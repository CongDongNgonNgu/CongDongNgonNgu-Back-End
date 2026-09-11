BEGIN;

DROP TABLE IF EXISTS community_reports;
DROP TABLE IF EXISTS community_saved_posts;
DROP TABLE IF EXISTS community_reactions;
DROP TABLE IF EXISTS community_comments;
DROP TABLE IF EXISTS community_posts;

DROP TYPE IF EXISTS community_report_state;
DROP TYPE IF EXISTS community_report_category;
DROP TYPE IF EXISTS community_reaction_type;
DROP TYPE IF EXISTS community_moderation_state;
DROP TYPE IF EXISTS community_post_visibility;
DROP TYPE IF EXISTS community_cefr_level;
DROP TYPE IF EXISTS community_post_type;

COMMIT;
