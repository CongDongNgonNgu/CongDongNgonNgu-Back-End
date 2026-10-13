// Shared by recipient projection and the single database unread-count query.
// The alias is an internal SQL identifier, never request data.
export function currentCommunityNotificationSource(alias: "n"): string {
  return `SELECT actor.id AS actor_user_id, actor.display_name, p.id AS parent_post_id
    FROM community_posts p
    JOIN languages l ON l.id=p.target_language_id AND l.active
    JOIN users owner ON owner.id=p.author_user_id AND owner.status='ACTIVE' AND owner.email_verified_at IS NOT NULL
    JOIN users recipient ON recipient.id=${alias}.recipient_user_id AND recipient.status='ACTIVE' AND recipient.email_verified_at IS NOT NULL
    CROSS JOIN LATERAL (
      SELECT c.author_user_id AS actor_user_id FROM community_comments c
      LEFT JOIN community_comments parent ON parent.id=c.parent_comment_id AND parent.post_id=c.post_id
      LEFT JOIN users parent_author ON parent_author.id=parent.author_user_id
      WHERE ${alias}.notification_type='COMMENT_REPLY'
        AND ${alias}.target->>'kind'='COMMUNITY_POST' AND ${alias}.target->>'id'=p.id::text
        AND c.id=${alias}.source_event_id AND c.post_id=p.id AND c.moderation_state='ACTIVE'
        AND (c.parent_comment_id IS NULL OR (parent.moderation_state='ACTIVE'
          AND parent_author.status='ACTIVE' AND parent_author.email_verified_at IS NOT NULL))
        AND COALESCE(parent.author_user_id,p.author_user_id)=${alias}.recipient_user_id
      UNION ALL
      SELECT a.accepted_by_user_id FROM community_structured_response_acceptances a
      JOIN community_structured_responses r ON r.id=a.response_id AND r.parent_post_id=a.parent_post_id
      WHERE ${alias}.notification_type IN ('ANSWER_ACCEPTED','CORRECTION_ACCEPTED')
        AND ${alias}.target->>'kind'='CORRECTION_RESPONSE' AND ${alias}.target->>'id'=r.id::text
        AND a.id=${alias}.source_event_id AND a.parent_post_id=p.id AND a.revoked_at IS NULL
        AND a.accepted_by_user_id=p.author_user_id AND r.author_user_id=${alias}.recipient_user_id
        AND r.moderation_state='ACTIVE'
        AND ((${alias}.notification_type='ANSWER_ACCEPTED' AND p.post_type='QUESTION' AND r.response_kind='QA_ANSWER')
          OR (${alias}.notification_type='CORRECTION_ACCEPTED' AND p.post_type='CORRECTION_REQUEST' AND r.response_kind='CORRECTION_PROPOSAL'))
    ) source
    JOIN users actor ON actor.id=source.actor_user_id AND actor.status='ACTIVE' AND actor.email_verified_at IS NOT NULL
    WHERE p.moderation_state='ACTIVE' AND (p.visibility='PUBLIC' OR p.author_user_id=${alias}.recipient_user_id)
      AND actor.id<>${alias}.recipient_user_id
      AND NOT EXISTS (SELECT 1 FROM notification_preferences pref WHERE pref.user_id=${alias}.recipient_user_id
        AND pref.category=${alias}.category AND pref.channel='IN_APP' AND NOT pref.enabled)`;
}
