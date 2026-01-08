import { z } from "zod";
import { getDb, type Env } from "../db";
import { respondJson } from "../lib/respond";
import {
  CollectionsListResponseSchema,
  CollectionDetailResponseSchema,
} from "../contracts/responses";

const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i, "Invalid slug");

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

function safeJsonParse<T>(v: unknown): T {
  if (Array.isArray(v)) return v as T;
  if (typeof v === "string") return JSON.parse(v) as T;
  return v as T;
}

/**
 * GET /api/collections
 * Returns paginated list of collections with bookCount.
 */
export async function handleGetCollections(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  const url = new URL(request.url);
  const parsed = ListQuerySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success) {
    return respondJson(
      z.object({ error: z.string(), details: z.any() }),
      { error: "Invalid query", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { page, pageSize } = parsed.data;
  const offset = (page - 1) * pageSize;

  const sql = getDb(env);

  const countRows = await sql`
    SELECT COUNT(*)::int AS total
    FROM collections
  `;
  const total: number = (countRows?.[0]?.total ?? 0) as number;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const rows = await sql`
    SELECT
      c.id::text AS id,
      c.slug,
      c.title,
      c.description,
      c.cover_url,
      COALESCE(COUNT(cb.book_id), 0)::int AS book_count
    FROM collections c
    LEFT JOIN collection_books cb ON cb.collection_id = c.id
    GROUP BY c.id
    ORDER BY c.title ASC
    LIMIT ${pageSize}
    OFFSET ${offset}
  `;

  const payload: z.infer<typeof CollectionsListResponseSchema> = {
    page,
    pageSize,
    total,
    totalPages,
    items: rows.map((r: any) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      description: r.description ?? null,
      coverUrl: r.cover_url ?? null,
      bookCount: r.book_count ?? 0,
    })),
  };

  return respondJson(CollectionsListResponseSchema, payload, {
    cacheControl: "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
  });
}

/**
 * GET /api/collections/:slug
 * Returns collection meta + books in that collection.
 * Embedded books include authors + non-sensitive tags (same behavior as /api/books).
 */
export async function handleGetCollectionBySlug(
  request: Request,
  env: Env,
  slugRaw: string
): Promise<Response> {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  const slug = SlugSchema.safeParse(slugRaw);
  if (!slug.success) {
    return respondJson(z.object({ error: z.string() }), { error: "Invalid slug" }, { status: 400 });
  }

  const sql = getDb(env);

  const colRows = await sql`
    SELECT
      id::text AS id,
      slug,
      title,
      description,
      cover_url,
      created_at,
      updated_at
    FROM collections
    WHERE slug = ${slug.data}
    LIMIT 1
  `;

  if (!colRows || colRows.length === 0) {
    return respondJson(z.object({ error: z.string() }), { error: "Not Found" }, { status: 404 });
  }

  const c: any = colRows[0];

  const bookRows = await sql`
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
      ) AS tags,
      MIN(cb.book_order)::int AS book_order
    FROM collection_books cb
    JOIN books b ON b.id = cb.book_id
    LEFT JOIN book_authors ba ON ba.book_id = b.id
    LEFT JOIN authors a ON a.id = ba.author_id
    LEFT JOIN book_tags bt ON bt.book_id = b.id
    LEFT JOIN tags t ON t.id = bt.tag_id AND t.sensitive_flag = false
    WHERE cb.collection_id = ${c.id}
    GROUP BY b.id
    ORDER BY book_order ASC, b.title ASC
    LIMIT 500
  `;

  const payload: z.infer<typeof CollectionDetailResponseSchema> = {
    collection: {
      id: c.id,
      slug: c.slug,
      title: c.title,
      description: c.description ?? null,
      coverUrl: c.cover_url ?? null,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      books: bookRows.map((r: any) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        subtitle: r.subtitle ?? null,
        description: r.description ?? null,
        coverUrl: r.cover_url ?? null,
        publishedYear: r.published_year ?? null,
        pageCount: r.page_count ?? null,
        authors: safeJsonParse(r.authors),
        tags: safeJsonParse(r.tags),
      })),
    },
  };

  return respondJson(CollectionDetailResponseSchema, payload, {
    cacheControl: "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
  });
}
