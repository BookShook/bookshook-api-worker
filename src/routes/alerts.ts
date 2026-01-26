import { z } from "zod";
import { getDb, type Env as DbEnv } from "../db";
import { getAuthenticatedUser, jsonError, jsonSuccess } from "../lib/auth";

type Env = DbEnv & {
  SITE_ORIGIN: string;
};

// Schema for creating an alert
const CreateAlertSchema = z.object({
  email: z.string().email(),
  filterUrl: z.string().min(1),        // URL search params (e.g., "?tropes=grumpy-sunshine&exclude=love-triangle")
  filterJson: z.record(z.any()),       // Parsed filter object for querying
  name: z.string().max(100).optional(),
});

// Schema for updating an alert
const UpdateAlertSchema = z.object({
  name: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
});

/**
 * Generate a hash of the filter URL for deduplication
 * Using Web Crypto API (available in Workers)
 */
async function hashFilter(filterUrl: string): Promise<string> {
  // Normalize: sort params alphabetically
  const params = new URLSearchParams(filterUrl);
  const sorted = new URLSearchParams([...params.entries()].sort());
  const normalized = sorted.toString();

  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Ensures user exists in our users table (upsert)
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
 * POST /api/alerts
 * Create a new search alert (can be anonymous via email)
 */
export async function handleCreateAlert(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON body", "INVALID_JSON");
  }

  const parsed = CreateAlertSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "Invalid request", "VALIDATION_ERROR");
  }

  const { email, filterUrl, filterJson, name } = parsed.data;
  const sql = getDb(env);

  // Check if user is authenticated (optional for alerts)
  const auth = await getAuthenticatedUser(request, env.SITE_ORIGIN);
  const ghostMemberId = auth.ok ? auth.user.ghostMemberId : null;

  // If authenticated, ensure user record exists
  if (auth.ok) {
    await ensureUser(sql, auth.user.ghostMemberId, auth.user.email, auth.user.name, auth.user.isPaid);
  }

  // Hash the filter for deduplication
  const filterHash = await hashFilter(filterUrl);

  try {
    // Insert or update the alert
    const result = await sql`
      INSERT INTO search_alerts (
        ghost_member_id,
        email,
        filter_hash,
        filter_json,
        filter_url,
        name,
        is_active,
        created_at,
        updated_at
      )
      VALUES (
        ${ghostMemberId},
        ${email},
        ${filterHash},
        ${JSON.stringify(filterJson)}::jsonb,
        ${filterUrl},
        ${name ?? null},
        TRUE,
        NOW(),
        NOW()
      )
      ON CONFLICT (email, filter_hash) DO UPDATE SET
        is_active = TRUE,
        name = COALESCE(EXCLUDED.name, search_alerts.name),
        updated_at = NOW()
      RETURNING id, email, filter_url, name, is_active, created_at
    `;

    const alert = result[0];

    return jsonSuccess({
      success: true,
      alert: {
        id: alert.id,
        email: alert.email,
        filterUrl: alert.filter_url,
        name: alert.name,
        isActive: alert.is_active,
        createdAt: alert.created_at,
      },
    });
  } catch (err: any) {
    console.error("Failed to create alert:", err);
    return jsonError(500, "Failed to create alert", "INTERNAL_ERROR");
  }
}

/**
 * GET /api/alerts
 * Get all alerts for the authenticated user
 */
export async function handleGetAlerts(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const auth = await getAuthenticatedUser(request, env.SITE_ORIGIN);
  if (!auth.ok) {
    return jsonError(auth.status, auth.error, auth.code);
  }

  const sql = getDb(env);
  const { ghostMemberId, email } = auth.user;

  // Get alerts by either ghost_member_id or email
  const rows = await sql`
    SELECT
      id,
      email,
      filter_url,
      filter_json,
      name,
      match_count,
      is_active,
      last_notified_at,
      created_at
    FROM search_alerts
    WHERE ghost_member_id = ${ghostMemberId}
       OR email = ${email}
    ORDER BY created_at DESC
  `;

  const alerts = rows.map((row: any) => ({
    id: row.id,
    email: row.email,
    filterUrl: row.filter_url,
    filterJson: row.filter_json,
    name: row.name,
    matchCount: row.match_count,
    isActive: row.is_active,
    lastNotifiedAt: row.last_notified_at,
    createdAt: row.created_at,
  }));

  return jsonSuccess({ alerts });
}

/**
 * DELETE /api/alerts/:id
 * Delete a specific alert
 */
export async function handleDeleteAlert(
  request: Request,
  env: Env,
  alertId: string
): Promise<Response> {
  if (request.method !== "DELETE") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Validate UUID
  const uuidResult = z.string().uuid().safeParse(alertId);
  if (!uuidResult.success) {
    return jsonError(400, "Invalid alert ID", "INVALID_ALERT_ID");
  }

  const auth = await getAuthenticatedUser(request, env.SITE_ORIGIN);
  if (!auth.ok) {
    return jsonError(auth.status, auth.error, auth.code);
  }

  const sql = getDb(env);
  const { ghostMemberId, email } = auth.user;

  // Delete only if owned by this user
  const result = await sql`
    DELETE FROM search_alerts
    WHERE id = ${alertId}
      AND (ghost_member_id = ${ghostMemberId} OR email = ${email})
    RETURNING id
  `;

  if (!result || result.length === 0) {
    return jsonError(404, "Alert not found", "ALERT_NOT_FOUND");
  }

  return jsonSuccess({ success: true });
}

/**
 * PATCH /api/alerts/:id
 * Update an alert (toggle active, rename)
 */
export async function handleUpdateAlert(
  request: Request,
  env: Env,
  alertId: string
): Promise<Response> {
  if (request.method !== "PATCH") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Validate UUID
  const uuidResult = z.string().uuid().safeParse(alertId);
  if (!uuidResult.success) {
    return jsonError(400, "Invalid alert ID", "INVALID_ALERT_ID");
  }

  const auth = await getAuthenticatedUser(request, env.SITE_ORIGIN);
  if (!auth.ok) {
    return jsonError(auth.status, auth.error, auth.code);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON body", "INVALID_JSON");
  }

  const parsed = UpdateAlertSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "Invalid request", "VALIDATION_ERROR");
  }

  const { name, isActive } = parsed.data;
  const sql = getDb(env);
  const { ghostMemberId, email } = auth.user;

  // Build update query dynamically based on provided fields
  const updates: string[] = [];
  const values: any[] = [];

  if (name !== undefined) {
    updates.push("name");
    values.push(name);
  }
  if (isActive !== undefined) {
    updates.push("is_active");
    values.push(isActive);
  }

  if (updates.length === 0) {
    return jsonError(400, "No fields to update", "NO_UPDATES");
  }

  // Use raw query to build dynamic update
  let result;
  if (name !== undefined && isActive !== undefined) {
    result = await sql`
      UPDATE search_alerts
      SET name = ${name}, is_active = ${isActive}, updated_at = NOW()
      WHERE id = ${alertId}
        AND (ghost_member_id = ${ghostMemberId} OR email = ${email})
      RETURNING id, email, filter_url, name, is_active, created_at
    `;
  } else if (name !== undefined) {
    result = await sql`
      UPDATE search_alerts
      SET name = ${name}, updated_at = NOW()
      WHERE id = ${alertId}
        AND (ghost_member_id = ${ghostMemberId} OR email = ${email})
      RETURNING id, email, filter_url, name, is_active, created_at
    `;
  } else {
    result = await sql`
      UPDATE search_alerts
      SET is_active = ${isActive}, updated_at = NOW()
      WHERE id = ${alertId}
        AND (ghost_member_id = ${ghostMemberId} OR email = ${email})
      RETURNING id, email, filter_url, name, is_active, created_at
    `;
  }

  if (!result || result.length === 0) {
    return jsonError(404, "Alert not found", "ALERT_NOT_FOUND");
  }

  const alert = result[0];

  return jsonSuccess({
    success: true,
    alert: {
      id: alert.id,
      email: alert.email,
      filterUrl: alert.filter_url,
      name: alert.name,
      isActive: alert.is_active,
      createdAt: alert.created_at,
    },
  });
}

// Schema for unsubscribe
const UnsubscribeSchema = z.object({
  token: z.string().min(1),
});

/**
 * POST /api/alerts/unsubscribe
 * Unsubscribe from an alert via token (no auth required)
 */
export async function handleUnsubscribeAlert(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON body", "INVALID_JSON");
  }

  const parsed = UnsubscribeSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "Invalid request", "VALIDATION_ERROR");
  }

  const { token } = parsed.data;
  const sql = getDb(env);

  // Find and deactivate the alert by token
  const result = await sql`
    UPDATE search_alerts
    SET is_active = FALSE, updated_at = NOW()
    WHERE unsubscribe_token = ${token}
      AND is_active = TRUE
    RETURNING id, email
  `;

  if (!result || result.length === 0) {
    return jsonError(404, "Alert not found or already unsubscribed", "ALERT_NOT_FOUND");
  }

  console.log(`[Unsubscribe] Deactivated alert ${result[0].id} for ${result[0].email}`);

  return jsonSuccess({ success: true });
}
