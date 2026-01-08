import { z } from "zod";
import { getDb, type Env as DbEnv } from "../db";
import { requirePaidUser, jsonError, jsonSuccess } from "../lib/auth";

type Env = DbEnv & {
  SITE_ORIGIN: string;
};

const InteractionTypeSchema = z.enum(["heart", "save", "tbr", "blacklist_book", "blacklist_author"]);

const UpsertSchema = z.object({
  type: InteractionTypeSchema,
  bookId: z.string().uuid(),
  note: z.string().max(2000).optional(),
  rating: z.number().int().min(1).max(5).optional(),
});

const DeleteSchema = z.object({
  type: InteractionTypeSchema,
  bookId: z.string().uuid(),
});

/**
 * Ensures user exists in our users table (upsert on first interaction)
 */
async function ensureUser(sql: any, ghostMemberId: string, email: string, name: string | null, isPaid: boolean) {
  await sql`
    INSERT INTO users (ghost_member_id, email, name, is_paid, tiers, created_at, updated_at)
    VALUES (${ghostMemberId}, ${email}, ${name}, ${isPaid}, '[]'::jsonb, NOW(), NOW())
    ON CONFLICT (ghost_member_id) DO UPDATE SET
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      is_paid = EXCLUDED.is_paid,
      updated_at = NOW()
  `;
}

/**
 * GET /api/interactions/:bookId
 * Returns the user's interactions for a specific book
 */
export async function handleGetBookInteractions(
  request: Request,
  env: Env,
  bookId: string
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Validate bookId format
  const uuidResult = z.string().uuid().safeParse(bookId);
  if (!uuidResult.success) {
    return jsonError(400, "Invalid book ID", "INVALID_BOOK_ID");
  }

  const auth = await requirePaidUser(request, env.SITE_ORIGIN);
  if (!auth.ok) {
    return jsonError(auth.status, auth.error, auth.code);
  }

  const sql = getDb(env);
  const { ghostMemberId } = auth.user;

  const rows = await sql`
    SELECT type, value_json
    FROM user_book_interactions
    WHERE ghost_member_id = ${ghostMemberId}
      AND book_id = ${bookId}
  `;

  // Build interactions object
  const interactions: Record<string, boolean> = {};
  for (const row of rows) {
    interactions[row.type] = true;
  }

  return jsonSuccess({
    bookId,
    interactions: {
      heart: interactions.heart ?? false,
      save: interactions.save ?? false,
      tbr: interactions.tbr ?? false,
    },
  });
}

/**
 * POST /api/interactions
 * Create or update an interaction
 */
export async function handlePostInteraction(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const auth = await requirePaidUser(request, env.SITE_ORIGIN);
  if (!auth.ok) {
    return jsonError(auth.status, auth.error, auth.code);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON body", "INVALID_JSON");
  }

  const parsed = UpsertSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "Invalid request", "VALIDATION_ERROR");
  }

  const { type, bookId, note, rating } = parsed.data;
  const sql = getDb(env);
  const { ghostMemberId, email, name, isPaid } = auth.user;

  // Ensure user exists
  await ensureUser(sql, ghostMemberId, email, name, isPaid);

  // Verify book exists
  const bookCheck = await sql`SELECT id FROM books WHERE id = ${bookId} LIMIT 1`;
  if (!bookCheck || bookCheck.length === 0) {
    return jsonError(404, "Book not found", "BOOK_NOT_FOUND");
  }

  // Build value_json
  const valueJson: Record<string, unknown> = {};
  if (note !== undefined) valueJson.note = note;
  if (rating !== undefined) valueJson.rating = rating;

  // Upsert interaction
  await sql`
    INSERT INTO user_book_interactions (ghost_member_id, book_id, type, value_json, created_at, updated_at)
    VALUES (${ghostMemberId}, ${bookId}, ${type}, ${JSON.stringify(valueJson)}::jsonb, NOW(), NOW())
    ON CONFLICT (ghost_member_id, book_id, type) DO UPDATE SET
      value_json = EXCLUDED.value_json,
      updated_at = NOW()
  `;

  return jsonSuccess({ success: true });
}

/**
 * DELETE /api/interactions
 * Remove an interaction
 */
export async function handleDeleteInteraction(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "DELETE") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const auth = await requirePaidUser(request, env.SITE_ORIGIN);
  if (!auth.ok) {
    return jsonError(auth.status, auth.error, auth.code);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON body", "INVALID_JSON");
  }

  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "Invalid request", "VALIDATION_ERROR");
  }

  const { type, bookId } = parsed.data;
  const sql = getDb(env);
  const { ghostMemberId } = auth.user;

  await sql`
    DELETE FROM user_book_interactions
    WHERE ghost_member_id = ${ghostMemberId}
      AND book_id = ${bookId}
      AND type = ${type}
  `;

  return jsonSuccess({ success: true });
}
