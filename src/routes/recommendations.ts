import { getDb, type Env as DbEnv } from "../db";
import { requirePaidUser, jsonError, jsonSuccess } from "../lib/auth";

type Env = DbEnv & {
  SITE_ORIGIN: string;
};

/**
 * GET /api/recommendations
 * Returns personalized book recommendations for the user.
 *
 * Rule-based MVP scoring:
 * - Filters out user's blacklisted books
 * - Filters out user's blacklisted authors
 * - Filters out books with user's excluded tags
 * - Scores based on:
 *   - Matched preferred tags (P * 10)
 *   - New releases within 60 days (+2)
 *   - Editor score (S / 100 * 3)
 */
export async function handleGetRecommendations(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const auth = await requirePaidUser(request, env.SITE_ORIGIN);
  if (!auth.ok) {
    return jsonError(auth.status, auth.error, auth.code);
  }

  const sql = getDb(env);
  const { ghostMemberId } = auth.user;

  // Get user's preferred tags
  const preferredTagRows = await sql`
    SELECT tag_id, weight
    FROM user_tag_preferences
    WHERE ghost_member_id = ${ghostMemberId}
      AND preference = 'prefer'
  `;
  const preferredTagIds = preferredTagRows.map((r: any) => r.tag_id);

  // Get user's excluded tags
  const excludedTagRows = await sql`
    SELECT tag_id
    FROM user_tag_preferences
    WHERE ghost_member_id = ${ghostMemberId}
      AND preference = 'exclude'
  `;
  const excludedTagIds = excludedTagRows.map((r: any) => r.tag_id);

  // Get user's blacklisted books
  const blacklistedBookRows = await sql`
    SELECT book_id
    FROM user_book_interactions
    WHERE ghost_member_id = ${ghostMemberId}
      AND type = 'blacklist_book'
  `;
  const blacklistedBookIds = blacklistedBookRows.map((r: any) => r.book_id);

  // Get user's blacklisted authors
  const blacklistedAuthorRows = await sql`
    SELECT author_id
    FROM user_author_blacklist
    WHERE ghost_member_id = ${ghostMemberId}
  `;
  const blacklistedAuthorIds = blacklistedAuthorRows.map((r: any) => r.author_id);

  // Get books the user has already interacted with (to optionally exclude)
  const interactedBookRows = await sql`
    SELECT DISTINCT book_id
    FROM user_book_interactions
    WHERE ghost_member_id = ${ghostMemberId}
      AND type IN ('heart', 'tbr')
  `;
  const interactedBookIds = interactedBookRows.map((r: any) => r.book_id);

  // Build the recommendations query
  // For MVP: get books, calculate score, exclude blacklisted
  const rows = await sql`
    WITH book_scores AS (
      SELECT
        b.id,
        b.slug,
        b.title,
        b.subtitle,
        b.description,
        b.cover_url,
        b.published_year,
        b.page_count,
        b.editor_score,
        b.published_at,
        -- Count matched preferred tags
        COUNT(DISTINCT bt.tag_id) FILTER (
          WHERE bt.tag_id = ANY(${preferredTagIds.length > 0 ? preferredTagIds : [null]})
        ) AS matched_tag_count,
        -- New release bonus (published within 60 days)
        CASE
          WHEN b.published_at >= CURRENT_DATE - INTERVAL '60 days' THEN 2
          ELSE 0
        END AS new_release_bonus,
        -- Editor score contribution
        COALESCE(b.editor_score, 0)::float / 100 * 3 AS editor_bonus
      FROM books b
      LEFT JOIN book_tags bt ON bt.book_id = b.id
      LEFT JOIN book_authors ba ON ba.book_id = b.id
      WHERE b.status = 'approved'
        -- Exclude blacklisted books
        ${blacklistedBookIds.length > 0 ? sql`AND b.id != ALL(${blacklistedBookIds})` : sql``}
        -- Exclude already interacted books
        ${interactedBookIds.length > 0 ? sql`AND b.id != ALL(${interactedBookIds})` : sql``}
        -- Exclude books by blacklisted authors
        ${blacklistedAuthorIds.length > 0 ? sql`AND ba.author_id != ALL(${blacklistedAuthorIds})` : sql``}
        -- Exclude books with excluded tags
        ${excludedTagIds.length > 0 ? sql`
          AND NOT EXISTS (
            SELECT 1 FROM book_tags bt_ex
            WHERE bt_ex.book_id = b.id
              AND bt_ex.tag_id = ANY(${excludedTagIds})
          )
        ` : sql``}
      GROUP BY b.id
    )
    SELECT
      bs.*,
      (bs.matched_tag_count * 10 + bs.new_release_bonus + bs.editor_bonus) AS score,
      COALESCE(
        jsonb_agg(
          DISTINCT jsonb_build_object(
            'id', a.id::text,
            'name', a.name,
            'slug', a.slug
          )
        ) FILTER (WHERE a.id IS NOT NULL),
        '[]'::jsonb
      ) AS authors,
      COALESCE(
        jsonb_agg(
          DISTINCT jsonb_build_object(
            'id', t.id::text,
            'category', t.category,
            'name', t.name,
            'slug', t.slug,
            'singleSelect', t.single_select
          )
        ) FILTER (WHERE t.id IS NOT NULL),
        '[]'::jsonb
      ) AS tags
    FROM book_scores bs
    LEFT JOIN book_authors ba ON ba.book_id = bs.id
    LEFT JOIN authors a ON a.id = ba.author_id
    LEFT JOIN book_tags bt ON bt.book_id = bs.id
    LEFT JOIN tags t ON t.id = bt.tag_id AND t.sensitive_flag = false
    GROUP BY bs.id, bs.slug, bs.title, bs.subtitle, bs.description,
             bs.cover_url, bs.published_year, bs.page_count, bs.editor_score,
             bs.published_at, bs.matched_tag_count, bs.new_release_bonus, bs.editor_bonus
    ORDER BY
      (bs.matched_tag_count * 10 + bs.new_release_bonus + bs.editor_bonus) DESC,
      bs.published_at DESC NULLS LAST,
      bs.title ASC
    LIMIT 24
  `;

  const items = rows.map((r: any) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    subtitle: r.subtitle ?? null,
    description: r.description ?? null,
    coverUrl: r.cover_url ?? null,
    publishedYear: r.published_year ?? null,
    pageCount: r.page_count ?? null,
    authors: Array.isArray(r.authors) ? r.authors : JSON.parse(r.authors),
    tags: Array.isArray(r.tags) ? r.tags : JSON.parse(r.tags),
  }));

  // Message based on whether user has preferences set
  let message: string | undefined;
  if (preferredTagIds.length === 0) {
    message = "Set your tag preferences to get personalized recommendations!";
  }

  return jsonSuccess({
    items,
    message,
  });
}
