import { z } from "zod";
import { getDb, type Env } from "../db";

const QuerySchema = z.object({
  category: z.string().trim().min(1).optional(),
  include_sensitive: z.enum(["true", "false"]).optional(),
});

const TagCategoryRowSchema = z.object({
  slug: z.string(),
  display_name: z.string(),
  description: z.string().nullable(),
  single_select: z.boolean(),
  is_premium: z.boolean(),
  display_order: z.number(),
});

const TagRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  display_name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  parent_tag_id: z.string().nullable(),
  is_premium: z.boolean(),
  sensitive_flag: z.boolean(),
  display_order: z.number(),
});

type TagCategoryRow = z.infer<typeof TagCategoryRowSchema>;
type TagRow = z.infer<typeof TagRowSchema>;

export async function handleGetTags(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    category: url.searchParams.get("category") ?? undefined,
    include_sensitive: url.searchParams.get("include_sensitive") ?? undefined,
  });

  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: "Invalid query", details: parsed.error.flatten() }),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }

  const { category, include_sensitive } = parsed.data;
  const includeSensitive = include_sensitive === "true";
  const sql = getDb(env);

  // Fetch categories
  // Note: In schema, key = slug, label = display_name
  // Check if is_premium column exists first
  const hasPremiumCol = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'tag_categories' AND column_name = 'is_premium'
    ) AS has_col
  `;
  const categoryHasPremium = hasPremiumCol[0]?.has_col === true;

  const categoriesRaw = categoryHasPremium
    ? await sql`
        SELECT
          key AS slug,
          label AS display_name,
          NULL AS description,
          single_select,
          COALESCE(is_premium, FALSE) AS is_premium,
          display_order
        FROM tag_categories
        ORDER BY display_order ASC
      `
    : await sql`
        SELECT
          key AS slug,
          label AS display_name,
          NULL AS description,
          single_select,
          FALSE AS is_premium,
          display_order
        FROM tag_categories
        ORDER BY display_order ASC
      `;

  const categories = z.array(TagCategoryRowSchema).parse(categoriesRaw);

  // Fetch tags
  // Note: In schema, name = display_name
  // Check if is_premium column exists on tags table
  const tagHasPremiumCol = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'tags' AND column_name = 'is_premium'
    ) AS has_col
  `;
  const tagHasPremium = tagHasPremiumCol[0]?.has_col === true;

  // Build query based on filters and column availability
  let tagsRaw;
  if (tagHasPremium) {
    tagsRaw = category
      ? includeSensitive
        ? await sql`
            SELECT id::text AS id, slug, name AS display_name, description, category,
                   parent_tag_id::text AS parent_tag_id, COALESCE(is_premium, FALSE) AS is_premium,
                   sensitive_flag, display_order
            FROM tags WHERE category = ${category} ORDER BY display_order ASC
          `
        : await sql`
            SELECT id::text AS id, slug, name AS display_name, description, category,
                   parent_tag_id::text AS parent_tag_id, COALESCE(is_premium, FALSE) AS is_premium,
                   sensitive_flag, display_order
            FROM tags WHERE sensitive_flag = false AND category = ${category} ORDER BY display_order ASC
          `
      : includeSensitive
        ? await sql`
            SELECT id::text AS id, slug, name AS display_name, description, category,
                   parent_tag_id::text AS parent_tag_id, COALESCE(is_premium, FALSE) AS is_premium,
                   sensitive_flag, display_order
            FROM tags ORDER BY category ASC, display_order ASC
          `
        : await sql`
            SELECT id::text AS id, slug, name AS display_name, description, category,
                   parent_tag_id::text AS parent_tag_id, COALESCE(is_premium, FALSE) AS is_premium,
                   sensitive_flag, display_order
            FROM tags WHERE sensitive_flag = false ORDER BY category ASC, display_order ASC
          `;
  } else {
    tagsRaw = category
      ? includeSensitive
        ? await sql`
            SELECT id::text AS id, slug, name AS display_name, description, category,
                   parent_tag_id::text AS parent_tag_id, FALSE AS is_premium,
                   sensitive_flag, display_order
            FROM tags WHERE category = ${category} ORDER BY display_order ASC
          `
        : await sql`
            SELECT id::text AS id, slug, name AS display_name, description, category,
                   parent_tag_id::text AS parent_tag_id, FALSE AS is_premium,
                   sensitive_flag, display_order
            FROM tags WHERE sensitive_flag = false AND category = ${category} ORDER BY display_order ASC
          `
      : includeSensitive
        ? await sql`
            SELECT id::text AS id, slug, name AS display_name, description, category,
                   parent_tag_id::text AS parent_tag_id, FALSE AS is_premium,
                   sensitive_flag, display_order
            FROM tags ORDER BY category ASC, display_order ASC
          `
        : await sql`
            SELECT id::text AS id, slug, name AS display_name, description, category,
                   parent_tag_id::text AS parent_tag_id, FALSE AS is_premium,
                   sensitive_flag, display_order
            FROM tags WHERE sensitive_flag = false ORDER BY category ASC, display_order ASC
          `;
  }

  const tags = z.array(TagRowSchema).parse(tagsRaw);

  return new Response(
    JSON.stringify({
      categories,
      tags,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
      },
    }
  );
}
