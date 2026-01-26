/**
 * Cron job to process search alerts - DAILY DIGEST version
 *
 * Runs hourly:
 *   1. Find new matching books for each alert
 *   2. Queue them in pending_book_ids
 *   3. If next_digest_at has passed, send digest email and reset
 */

import { getDb, type Env } from "../db";

// Bridge worker URL for sending notifications
const BRIDGE_URL = "https://bookshook-bridge.faith-072.workers.dev";

type Alert = {
  id: string;
  email: string;
  filter_json: {
    include?: string[];
    exclude?: string[];
    df?: string[];
    q?: string;
  };
  filter_url: string;
  name: string | null;
  match_count: number;
  pending_book_ids: string[];
  next_digest_at: string;
  digest_hour: number;
  unsubscribe_token: string;
  last_checked_at: string | null;
};

type Book = {
  id: string;
  title: string;
  slug: string;
  cover_url: string | null;
  author_name: string | null;
};

/**
 * Generate SHA256 hash for dedupe
 */
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build WHERE clause from filter JSON
 */
function buildFilterConditions(filter: Alert["filter_json"]): {
  conditions: string[];
  params: any[];
} {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  // Include tags (must have all)
  if (filter.include && filter.include.length > 0) {
    conditions.push(`
      EXISTS (
        SELECT 1 FROM book_tags bt
        JOIN tags t ON t.id = bt.tag_id
        WHERE bt.book_id = b.id
        AND t.slug = ANY($${paramIndex}::text[])
        GROUP BY bt.book_id
        HAVING COUNT(DISTINCT t.slug) = $${paramIndex + 1}::int
      )
    `);
    params.push(filter.include, filter.include.length);
    paramIndex += 2;
  }

  // Exclude tags (must not have any)
  if (filter.exclude && filter.exclude.length > 0) {
    conditions.push(`
      NOT EXISTS (
        SELECT 1 FROM book_tags bt
        JOIN tags t ON t.id = bt.tag_id
        WHERE bt.book_id = b.id
        AND t.slug = ANY($${paramIndex}::text[])
      )
    `);
    params.push(filter.exclude);
    paramIndex += 1;
  }

  // Text search
  if (filter.q && filter.q.trim()) {
    conditions.push(`
      (b.title ILIKE $${paramIndex} OR b.author_name ILIKE $${paramIndex})
    `);
    params.push(`%${filter.q.trim()}%`);
    paramIndex += 1;
  }

  return { conditions, params };
}

/**
 * Find all matching book IDs for an alert
 */
async function findMatchingBookIds(
  sql: ReturnType<typeof getDb>,
  alert: Alert
): Promise<string[]> {
  const { conditions, params } = buildFilterConditions(alert.filter_json);

  let whereClause = "b.is_published = TRUE";
  if (conditions.length > 0) {
    whereClause += " AND " + conditions.join(" AND ");
  }

  const query = `SELECT b.id FROM books b WHERE ${whereClause}`;
  const rows = await sql(query, params);

  return rows.map((r: any) => r.id);
}

// Max books to show in digest email (keeps email lightweight)
const MAX_DIGEST_BOOKS = 8;

/**
 * Get book details for a list of IDs
 */
async function getBookDetails(
  sql: ReturnType<typeof getDb>,
  bookIds: string[]
): Promise<Book[]> {
  if (bookIds.length === 0) return [];

  const rows = await sql`
    SELECT id, title, slug, cover_url, author_name
    FROM books
    WHERE id = ANY(${bookIds}::uuid[])
    ORDER BY created_at DESC
    LIMIT ${MAX_DIGEST_BOOKS}
  `;

  return rows.map((r: any) => ({
    id: r.id,
    title: r.title,
    slug: r.slug,
    cover_url: r.cover_url,
    author_name: r.author_name,
  }));
}

/**
 * Check if this exact notification was already sent (dedupe)
 */
async function wasAlreadySent(
  sql: ReturnType<typeof getDb>,
  alertId: string,
  notifyKey: string
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM alert_notification_keys
    WHERE alert_id = ${alertId} AND notify_key = ${notifyKey}
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Record that we sent this notification (for dedupe)
 */
async function recordNotification(
  sql: ReturnType<typeof getDb>,
  alertId: string,
  notifyKey: string,
  bookIds: string[]
): Promise<void> {
  await sql`
    INSERT INTO alert_notification_keys (alert_id, notify_key, book_ids)
    VALUES (${alertId}, ${notifyKey}, ${bookIds}::uuid[])
    ON CONFLICT (alert_id, notify_key) DO NOTHING
  `;
}

/**
 * Send digest email via bridge worker
 */
async function sendDigestEmail(
  alert: Alert,
  books: Book[],
  totalCount: number
): Promise<void> {
  const vaultLink = `https://bookshook.com/vault/books${alert.filter_url}`;
  const unsubLink = `https://bookshook-bridge.faith-072.workers.dev/alerts/unsubscribe?token=${alert.unsubscribe_token}`;

  const payload = {
    event: "search_alert_digest",
    email: alert.email,
    alertId: alert.id,
    alertName: alert.name || "Your saved search",
    books: books.map(b => ({
      id: b.id,
      title: b.title,
      slug: b.slug,
      // Cover URL - use Cloudflare Image Resizing if enabled
      // To enable: Cloudflare Dashboard > Images > Image Resizing > Enable
      // Then change url to: .replace("/covers/", "/cdn-cgi/image/w=120,h=180,fit=cover,q=80/covers/")
      coverUrl: b.cover_url || "https://bookshook.com/images/placeholder-cover.png",
      author: b.author_name,
      link: `https://bookshook.com/vault/books/${b.slug}`,
    })),
    filterUrl: alert.filter_url,
    vaultLink,
    unsubscribeLink: unsubLink,
    bookCount: books.length,         // books shown in email
    totalBookCount: totalCount,      // total matches for CTA
  };

  console.log(`[Digest] Sending ${books.length} books to ${alert.email}`);

  const res = await fetch(`${BRIDGE_URL}/alerts/digest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bridge error: ${res.status} ${text}`);
  }
}

/**
 * Process a single alert: find new matches, queue or send digest
 */
async function processAlert(
  sql: ReturnType<typeof getDb>,
  alert: Alert,
  now: Date
): Promise<{ queued: number; sent: boolean }> {
  // Step 1: Find all currently matching book IDs
  const currentMatchIds = await findMatchingBookIds(sql, alert);
  const currentMatchSet = new Set(currentMatchIds);

  // Step 2: Find NEW books (not in previous match_count tracking)
  // We use pending_book_ids to track what's already queued
  const pendingSet = new Set(alert.pending_book_ids || []);
  const newBookIds = currentMatchIds.filter(id => !pendingSet.has(id));

  // Add new books to pending queue
  const updatedPending = [...pendingSet, ...newBookIds];

  // Step 3: Check if it's time to send digest
  const digestTime = new Date(alert.next_digest_at);
  const shouldSendDigest = now >= digestTime && updatedPending.length > 0;

  let sent = false;

  if (shouldSendDigest) {
    // Generate dedupe key
    const sortedIds = [...updatedPending].sort();
    const dateKey = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const notifyKey = await sha256(`${alert.id}:${dateKey}:${sortedIds.join(",")}`);

    // Check if already sent
    if (await wasAlreadySent(sql, alert.id, notifyKey)) {
      console.log(`[Digest] Skipping ${alert.email} - already sent today`);
    } else {
      // Get book details and send (limited to MAX_DIGEST_BOOKS)
      const books = await getBookDetails(sql, updatedPending);

      if (books.length > 0) {
        await sendDigestEmail(alert, books, updatedPending.length);
        await recordNotification(sql, alert.id, notifyKey, updatedPending);
        sent = true;
      }
    }

    // Reset pending and schedule next digest (tomorrow at digest_hour)
    const nextDigest = new Date(now);
    nextDigest.setUTCDate(nextDigest.getUTCDate() + 1);
    nextDigest.setUTCHours(alert.digest_hour, 0, 0, 0);

    await sql`
      UPDATE search_alerts
      SET
        pending_book_ids = '{}',
        match_count = ${currentMatchIds.length},
        next_digest_at = ${nextDigest.toISOString()},
        last_notified_at = ${sent ? now.toISOString() : sql`last_notified_at`},
        last_checked_at = NOW()
      WHERE id = ${alert.id}
    `;
  } else {
    // Just update pending queue and match count
    await sql`
      UPDATE search_alerts
      SET
        pending_book_ids = ${updatedPending}::uuid[],
        match_count = ${currentMatchIds.length},
        last_checked_at = NOW()
      WHERE id = ${alert.id}
    `;
  }

  return { queued: newBookIds.length, sent };
}

/**
 * Main cron handler
 */
export async function processSearchAlerts(env: Env): Promise<void> {
  const sql = getDb(env);
  const now = new Date();
  const startTime = Date.now();

  console.log(`[Cron] Starting search alert processing at ${now.toISOString()}`);

  // Get all active alerts
  const alerts = await sql`
    SELECT
      id,
      email,
      filter_json,
      filter_url,
      name,
      match_count,
      pending_book_ids,
      next_digest_at,
      digest_hour,
      unsubscribe_token,
      last_checked_at
    FROM search_alerts
    WHERE is_active = TRUE
    ORDER BY last_checked_at ASC NULLS FIRST
    LIMIT 200
  `;

  console.log(`[Cron] Processing ${alerts.length} active alerts`);

  let processed = 0;
  let digestsSent = 0;
  let booksQueued = 0;
  let errors = 0;

  for (const alertRow of alerts) {
    const alert = alertRow as unknown as Alert;

    try {
      const result = await processAlert(sql, alert, now);
      processed++;
      booksQueued += result.queued;
      if (result.sent) digestsSent++;
    } catch (err: any) {
      console.error(`[Cron] Error processing alert ${alert.id}:`, err.message);
      errors++;
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(
    `[Cron] Complete: ${processed} processed, ${digestsSent} digests sent, ` +
    `${booksQueued} books queued, ${errors} errors (${elapsed}ms)`
  );
}
