import { z } from "zod";
import { getDb, type Env } from "../db";

const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i, "Invalid slug");

const ListQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  // Comma-separated tag slugs. Matches ANY of the tags.
  tags: z.string().trim().optional(),
});

type BookListItem = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  coverUrl: string | null;
  publishedYear: number | null;
  pageCount: number | null;
  authors: { id: string; name: string; slug: string }[];
  tags: { id: string; category: string; name: string; slug: string; singleSelect: boolean }[];
};

function parseTagsParam(tagsRaw?: string): string[] | null {
  if (!tagsRaw) return null;
  const slugs = tagsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 25); // guardrail
  if (slugs.length === 0) return null;
  // Validate tag slug-ish characters (keep permissive, but safe)
  for (const s of slugs) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(s)) {
      throw new Error(`Invalid tag slug: ${s}`);
    }
  }
  return Array.from(new Set(slugs));
}

function json(headers: Record<string, string>, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

/**
 * GET /api/books
 * Query:
 * - q: fuzzy search against title/subtitle/authors
 * - tags: comma-separated tag slugs (ANY match)
 * - page, pageSize
 *
 * Sensitive tags are hidden by default (tags.sensitive_flag = false).
 */
export async function handleGetBooks(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  const url = new URL(request.url);
  const parsed = ListQuerySchema.safeParse({
    q: url.searchParams.get("q") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    tags: url.searchParams.get("tags") ?? undefined,
  });

  if (!parsed.success) {
    return json({}, { error: "Invalid query", details: parsed.error.flatten() }, 400);
  }

  let tagSlugs: string[] | null = null;
  try {
    tagSlugs = parseTagsParam(parsed.data.tags);
  } catch (e) {
    return json({}, { error: (e as Error).message }, 400);
  }

  const { q, page, pageSize } = parsed.data;
  const offset = (page - 1) * pageSize;

  const sql = getDb(env);

  // COUNT (distinct books)
  const countRows = await sql`
    SELECT COUNT(DISTINCT b.id)::int AS total
    FROM books b
    LEFT JOIN book_authors ba ON ba.book_id = b.id
    LEFT JOIN authors a ON a.id = ba.author_id
    ${
      tagSlugs
        ? sql`
          JOIN book_tags bt_filter ON bt_filter.book_id = b.id
          JOIN tags t_filter ON t_filter.id = bt_filter.tag_id
            AND t_filter.sensitive_flag = false
        `
        : sql``
    }
    WHERE 1=1
      ${
        q
          ? sql`
            AND (
              b.title % ${q}
              OR COALESCE(b.subtitle, '') % ${q}
              OR a.name % ${q}
              OR b.title ILIKE ${"%" + q + "%"}
              OR COALESCE(b.subtitle, '') ILIKE ${"%" + q + "%"}
              OR a.name ILIKE ${"%" + q + "%"}
            )
          `
          : sql``
      }
      ${tagSlugs ? sql`AND t_filter.slug = ANY(${tagSlugs})` : sql``}
  `;

  const total: number = (countRows?.[0]?.total ?? 0) as number;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // ITEMS
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
    FROM books b
    LEFT JOIN book_authors ba ON ba.book_id = b.id
    LEFT JOIN authors a ON a.id = ba.author_id
    LEFT JOIN book_tags bt ON bt.book_id = b.id
    LEFT JOIN tags t ON t.id = bt.tag_id AND t.sensitive_flag = false
    ${
      tagSlugs
        ? sql`
          JOIN book_tags bt_filter ON bt_filter.book_id = b.id
          JOIN tags t_filter ON t_filter.id = bt_filter.tag_id
            AND t_filter.sensitive_flag = false
        `
        : sql``
    }
    WHERE 1=1
      ${
        q
          ? sql`
            AND (
              b.title % ${q}
              OR COALESCE(b.subtitle, '') % ${q}
              OR a.name % ${q}
              OR b.title ILIKE ${"%" + q + "%"}
              OR COALESCE(b.subtitle, '') ILIKE ${"%" + q + "%"}
              OR a.name ILIKE ${"%" + q + "%"}
            )
          `
          : sql``
      }
      ${tagSlugs ? sql`AND t_filter.slug = ANY(${tagSlugs})` : sql``}
    GROUP BY b.id
    ORDER BY
      ${
        q
          ? sql`
            GREATEST(
              similarity(b.title, ${q}),
              similarity(COALESCE(b.subtitle, ''), ${q})
            ) DESC,
            b.title ASC
          `
          : sql`b.created_at DESC, b.title ASC`
      }
    LIMIT ${pageSize}
    OFFSET ${offset}
  `;

  const items: BookListItem[] = rows.map((r: any) => ({
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

  // Build filtersApplied object
  const filtersApplied: Record<string, unknown> = {};
  if (q) filtersApplied.q = q;
  if (tagSlugs) filtersApplied.tags = tagSlugs;

  // Determine sort used
  const sort = q ? "relevance" : "newest";

  return json(
    {
      // Search results change; cache lightly.
      "cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
    },
    {
      page,
      pageSize,
      total,
      totalPages,
      filtersApplied,
      sort,
      items,
    }
  );
}

/**
 * GET /api/books/:slug
 * Sensitive tags are hidden by default.
 */
export async function handleGetBookBySlug(request: Request, env: Env, slugRaw: string): Promise<Response> {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  const slug = SlugSchema.safeParse(slugRaw);
  if (!slug.success) return json({}, { error: "Invalid slug" }, 400);

  const sql = getDb(env);

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
      b.created_at,
      b.updated_at,
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
    FROM books b
    LEFT JOIN book_authors ba ON ba.book_id = b.id
    LEFT JOIN authors a ON a.id = ba.author_id
    LEFT JOIN book_tags bt ON bt.book_id = b.id
    LEFT JOIN tags t ON t.id = bt.tag_id AND t.sensitive_flag = false
    WHERE b.slug = ${slug.data}
    GROUP BY b.id
    LIMIT 1
  `;

  if (!rows || rows.length === 0) {
    return json({}, { error: "Not Found" }, 404);
  }

  const r: any = rows[0];

  const book = {
    id: r.id,
    slug: r.slug,
    title: r.title,
    subtitle: r.subtitle ?? null,
    description: r.description ?? null,
    coverUrl: r.cover_url ?? null,
    publishedYear: r.published_year ?? null,
    pageCount: r.page_count ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    authors: Array.isArray(r.authors) ? r.authors : JSON.parse(r.authors),
    tags: Array.isArray(r.tags) ? r.tags : JSON.parse(r.tags),
  };

  return json(
    {
      "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
    },
    { book }
  );
}
