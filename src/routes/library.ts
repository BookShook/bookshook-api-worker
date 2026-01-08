import { z } from "zod";
import { getDb, type Env as DbEnv } from "../db";
import { requirePaidUser, jsonError, jsonSuccess } from "../lib/auth";

type Env = DbEnv & {
  SITE_ORIGIN: string;
};

const QuerySchema = z.object({
  filter: z.enum(["all", "heart", "save", "tbr"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(24),
});

/**
 * GET /api/my/library
 * Returns the user's saved books (hearts, saves, TBR)
 */
export async function handleGetMyLibrary(
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

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    filter: url.searchParams.get("filter") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success) {
    return jsonError(400, "Invalid query parameters", "VALIDATION_ERROR");
  }

  const { filter, page, pageSize } = parsed.data;
  const offset = (page - 1) * pageSize;
  const sql = getDb(env);
  const { ghostMemberId } = auth.user;

  // Build type filter
  const typeFilter = filter === "all"
    ? ["heart", "save", "tbr"]
    : [filter];

  // Count total
  const countRows = await sql`
    SELECT COUNT(DISTINCT ubi.book_id)::int AS total
    FROM user_book_interactions ubi
    WHERE ubi.ghost_member_id = ${ghostMemberId}
      AND ubi.type = ANY(${typeFilter})
  `;
  const total = countRows?.[0]?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Get items with book details
  const rows = await sql`
    SELECT
      b.id::text AS id,
      b.slug,
      b.title,
      b.subtitle,
      b.description,
      b.cover_url,
      b.published_year,
      b.page_count,
      ubi.type AS interaction_type,
      ubi.created_at AS interaction_created_at,
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
    FROM user_book_interactions ubi
    JOIN books b ON b.id = ubi.book_id
    LEFT JOIN book_authors ba ON ba.book_id = b.id
    LEFT JOIN authors a ON a.id = ba.author_id
    LEFT JOIN book_tags bt ON bt.book_id = b.id
    LEFT JOIN tags t ON t.id = bt.tag_id AND t.sensitive_flag = false
    WHERE ubi.ghost_member_id = ${ghostMemberId}
      AND ubi.type = ANY(${typeFilter})
    GROUP BY b.id, ubi.type, ubi.created_at
    ORDER BY ubi.created_at DESC
    LIMIT ${pageSize}
    OFFSET ${offset}
  `;

  const items = rows.map((r: any) => ({
    book: {
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
    },
    interactionType: r.interaction_type,
    createdAt: r.interaction_created_at,
  }));

  return jsonSuccess({
    page,
    pageSize,
    total,
    totalPages,
    filter,
    items,
  });
}
