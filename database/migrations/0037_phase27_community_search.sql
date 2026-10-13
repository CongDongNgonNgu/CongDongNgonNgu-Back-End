-- Reuses pg_trgm installed by migration0010. No data rewrite or visibility change.
CREATE INDEX IF NOT EXISTS community_posts_search_content_trgm_idx
 ON community_posts USING gin (content gin_trgm_ops)
 WHERE visibility='PUBLIC' AND moderation_state='ACTIVE';
CREATE INDEX IF NOT EXISTS community_posts_search_type_topic_idx
 ON community_posts (post_type,topic,created_at DESC,id DESC)
 WHERE visibility='PUBLIC' AND moderation_state='ACTIVE';
CREATE INDEX IF NOT EXISTS community_answers_search_eligible_idx
 ON community_structured_responses (parent_post_id,author_user_id,id)
 WHERE response_kind='QA_ANSWER' AND moderation_state='ACTIVE';
