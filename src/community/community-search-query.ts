import type { CommunityPostListQuery } from './community.repository';
import { escapeLikeLiteral } from './community-search';
export function communitySearchQuery(query: CommunityPostListQuery): {
  text: string;
  values: unknown[];
} {
  const filters = query.search;
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return '$' + values.length;
  };
  const where = [
    `p.visibility='PUBLIC'`,
    `p.moderation_state='ACTIVE'`,
    `l.active=true`,
    `u.status='ACTIVE'`,
    'u.email_verified_at IS NOT NULL',
  ];
  if (filters?.q)
    where.push(
      `p.content ILIKE ${bind('%' + escapeLikeLiteral(filters.q) + '%')} ESCAPE E'\\\\'`,
    );
  if (filters?.languageCode ?? query.languageCode)
    where.push('l.code=' + bind(filters?.languageCode ?? query.languageCode));
  if (filters?.postType) where.push('p.post_type=' + bind(filters.postType));
  if (filters?.topic) where.push('p.topic=' + bind(filters.topic));
  if (filters?.savedByMe) {
    const actor = bind(query.searchActor);
    where.push(
      `EXISTS(SELECT 1 FROM community_saved_posts saved JOIN users reader ON reader.id=saved.user_id WHERE saved.post_id=p.id AND saved.user_id=${actor}::uuid AND reader.status='ACTIVE' AND reader.email_verified_at IS NOT NULL)`,
    );
  }
  const eligible = `SELECT 1 FROM community_structured_responses response JOIN users responder ON responder.id=response.author_user_id
   WHERE response.parent_post_id=p.id AND response.response_kind='QA_ANSWER' AND response.moderation_state='ACTIVE'
     AND response.author_user_id<>p.author_user_id AND responder.status='ACTIVE' AND responder.email_verified_at IS NOT NULL`;
  if (filters?.responseState === 'UNANSWERED')
    where.push('NOT EXISTS(' + eligible + ')');
  if (filters?.responseState === 'ANSWERED')
    where.push('EXISTS(' + eligible + ')');
  if (filters?.responseState === 'ACCEPTED')
    where.push(
      `EXISTS(${eligible} AND EXISTS(SELECT 1 FROM community_structured_response_acceptances acceptance WHERE acceptance.parent_post_id=p.id AND acceptance.response_id=response.id AND acceptance.accepted_by_user_id=p.author_user_id AND acceptance.revoked_at IS NULL))`,
    );
  const useful = filters?.sort === 'USEFUL';
  const score = `(SELECT count(*)::int FROM community_reactions reaction WHERE reaction.post_id=p.id AND reaction.reaction_type='HELPFUL')`;
  const before = query.searchBefore;
  if (before) {
    const timestamp = bind(before.createdAt),
      id = bind(before.id);
    where.push(
      useful
        ? `(${score},p.created_at,p.id)<(${bind(before.helpfulCount)}::int,${timestamp}::timestamptz,${id}::uuid)`
        : `(p.created_at,p.id)<(${timestamp}::timestamptz,${id}::uuid)`,
    );
  }
  if (query.searchIds)
    where.push('p.id=ANY(' + bind(query.searchIds) + '::uuid[])');
  const actor = bind(query.searchActor ?? null);
  const limit = bind(query.limit + 1);
  return {
    text: `SELECT p.*,l.code AS target_language_code,u.display_name AS search_author_name,
  json_build_object('code',l.code,'slug',l.slug,'nativeName',l.native_name,'englishName',l.english_name,'vietnameseName',l.vietnamese_name,'direction',l.direction) AS search_language,
  (SELECT count(*)::int FROM community_comments comment WHERE comment.post_id=p.id AND comment.moderation_state='ACTIVE') AS search_comment_count,
  EXISTS(SELECT 1 FROM community_reactions viewer_reaction WHERE viewer_reaction.post_id=p.id AND viewer_reaction.user_id=${actor}::uuid AND viewer_reaction.reaction_type='HELPFUL') AS search_viewer_reacted,
  EXISTS(SELECT 1 FROM community_saved_posts viewer_save WHERE viewer_save.post_id=p.id AND viewer_save.user_id=${actor}::uuid) AS search_viewer_saved,l.code AS target_language_code,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS search_created_at,
  ${score} AS search_helpful_count FROM community_posts p JOIN languages l ON l.id=p.target_language_id JOIN users u ON u.id=p.author_user_id
  WHERE ${where.join(' AND ')} ORDER BY ${useful ? 'search_helpful_count DESC,' : ''}p.created_at DESC,p.id DESC LIMIT ${limit}`,
    values,
  };
}
