import { z } from "zod";
import { getDb, type Env } from "../db";
import { getAuthenticatedUser } from "../lib/auth";

// Server-authoritative preset definitions
// When a preset is used, the server OVERWRITES any client-supplied filters
// This prevents gaming: ?preset=devastate&tags=anything_i_want won't work
type PresetDefinition = {
  tags?: string[];           // Authoritative tag slugs (server-owned)
  orderBy?: "newest" | "relevance";
  limit?: number;            // Optional cap for browse modes
};

const PRESET_DEFINITIONS: Record<string, PresetDefinition> = {
  // Mood presets - curated tag combinations
  devastate: {
    tags: ["angsty_emotional", "slow_burn", "hurt_comfort"],
    orderBy: "newest",
  },
  comfort: {
    tags: ["cozy_comfort_read", "rom_com_humor"],
    orderBy: "newest",
  },
  unhinged: {
    tags: ["dark_tone", "possessive_obsessive", "morally_grey_hero"],
    orderBy: "newest",
  },
  slowburn: {
    tags: ["slow_burn", "pining_unrequited", "enemies_to_lovers"],
    orderBy: "newest",
  },
  grovel: {
    tags: ["alphahole", "second_chance", "hurt_comfort"],
    orderBy: "newest",
  },
  // Browse modes - no tags, special ordering
  fresh: {
    // No tags - shows all recently added
    orderBy: "newest",
    limit: 60,
  },
};

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

  // Check for valid preset (server-authoritative filter bypass for free users)
  const presetParam = url.searchParams.get("preset");
  const presetDef = presetParam ? PRESET_DEFINITIONS[presetParam] : null;

  // SECURITY: If using a preset, server OVERWRITES client-supplied tags
  // This prevents gaming: ?preset=devastate&tags=anything_i_want
  if (presetDef) {
    // Server owns the query - ignore any client-supplied tags
    tagSlugs = presetDef.tags ?? null;
  }

  // Filter enforcement: tags require paid membership UNLESS using a valid preset
  if (tagSlugs && tagSlugs.length > 0 && !presetDef) {
    const auth = await getAuthenticatedUser(request, env.SITE_ORIGIN);
    if (!auth.ok || !auth.user.isPaid) {
      return json(
        { "cache-control": "no-store", vary: "cookie" },
        {
          code: "FILTER_REQUIRES_MEMBERSHIP",
          message: "Filtered search is members-only",
          upgradeUrl: "/join",
        },
        403
      );
    }
  }

  // Apply preset limit if specified (e.g., fresh mode caps at 60)
  const presetLimit = presetDef?.limit;

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
    LIMIT ${presetLimit ? Math.min(pageSize, presetLimit - offset) : pageSize}
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

  // Cap total if preset has a limit (e.g., fresh mode)
  const effectiveTotal = presetLimit ? Math.min(total, presetLimit) : total;
  const effectiveTotalPages = Math.max(1, Math.ceil(effectiveTotal / pageSize));

  return json(
    {
      // Search results change; cache lightly.
      "cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
    },
    {
      page,
      pageSize,
      total: effectiveTotal,
      totalPages: effectiveTotalPages,
      filtersApplied,
      sort,
      preset: presetParam || undefined, // Echo back which preset was used
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
