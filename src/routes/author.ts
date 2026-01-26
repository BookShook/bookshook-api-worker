import { z } from "zod";
import type { Env } from "../db";
import { getDb } from "../db";
import { json, badRequest, unauthorized, forbidden, notFound, serverError, tooManyRequests } from "../lib/respond";
import { parseCookies, verifySession, signSession, makeCookie, clearCookie, randomToken } from "../security/session";
import { requireCsrf } from "../security/csrf";
import { checkLoginRateLimit, checkSubmissionRateLimit, checkBookIntakeRateLimit } from "../security/ratelimit";
import { validateOrigin } from "../security/origin";

const AUTHOR_COOKIE = "bh_author";

const LoginSchema = z.object({
  token: z.string().min(16),
});

const SubmitSchema = z.object({
  book_id: z.string().uuid(),
  tag_id: z.string().uuid(),
  evidence: z.object({
    chapter: z.string().max(64).optional(),
    page: z.string().max(64).optional(),
    location: z.string().max(128).optional(), // flexible
    notes: z.string().max(400).optional(),
  }).default({}),
});

const TagSelectionSchema = z.object({
  tag_id: z.string().uuid(),
  anchor: z.object({
    chapter: z.string().max(64).optional(),
    page: z.string().max(64).optional(),
    percentage: z.string().max(16).optional(),
    notes: z.string().max(400).optional(),
  }).optional(),
});

const BookIntakeSchema = z.object({
  // Book details
  title: z.string().min(1).max(300),
  asin: z.string().length(10).regex(/^B0[A-Z0-9]{8}$/i, "Invalid ASIN format"),
  series_name: z.string().max(200).optional(),
  series_number: z.string().max(10).optional(),
  publication_date: z.string().optional(),

  // Required axes (tag_ids)
  world_framework: z.string().uuid(),
  pairing: z.string().uuid(),
  heat_level: z.string().uuid(),
  series_status: z.string().uuid(),
  consent_mode: z.string().uuid(),

  // Tag selections
  content_warnings: z.array(TagSelectionSchema).max(50).default([]),
  tropes: z.array(TagSelectionSchema).max(100).default([]),
  hero_archetypes: z.array(z.string().uuid()).max(10).default([]),
  heroine_archetypes: z.array(z.string().uuid()).max(10).default([]),
  representation: z.array(TagSelectionSchema).max(50).default([]),
  kink_bundles: z.array(z.string().uuid()).max(20).default([]),
  kink_details: z.array(TagSelectionSchema).max(50).default([]),

  // Notes
  notes: z.string().max(1000).optional(),
});

async function getAuthorSession(req: Request, env: Env) {
  const cookies = parseCookies(req);
  const raw = cookies[AUTHOR_COOKIE];
  if (!raw) return null;
  return await verifySession(raw, env.SESSION_SECRET);
}

export async function handleAuthor(req: Request, env: Env) {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/vault/author/")) return null;

  const db = getDb(env);
  const clientIp = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";

  // Origin check for all mutation requests
  if (!validateOrigin(req, env.SITE_ORIGIN)) {
    return forbidden("Invalid origin");
  }

  // POST /api/vault/author/login  (one-time invite token)
  if (req.method === "POST" && url.pathname === "/api/vault/author/login") {
    // Rate limit: 5 attempts per 15 minutes
    const rateCheck = await checkLoginRateLimit(env.RATE_LIMIT, clientIp, "author");
    if (!rateCheck.allowed) {
      return tooManyRequests("Too many login attempts. Try again later.", rateCheck.resetIn);
    }

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    const token = parsed.data.token;
    const tokenHash = await sha256Hex(token);

    const rows = await db/*sql*/`
      SELECT t.token_hash, t.expires_at, a.id AS author_account_id, a.author_id, a.email, a.status
      FROM author_portal_tokens t
      JOIN author_portal_accounts a ON a.id = t.author_account_id
      WHERE t.token_hash = ${tokenHash};
    `;
    // Use same error for all invalid token cases to avoid leaking info
    if (!rows.length || rows[0].status !== "active" || new Date(rows[0].expires_at).getTime() < Date.now()) {
      return unauthorized("Invalid or expired token");
    }

    // one-time use
    await db/*sql*/`DELETE FROM author_portal_tokens WHERE token_hash = ${tokenHash};`;

    const csrf = randomToken(18);
    const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 12; // 12h
    const session = await signSession({ sub: rows[0].author_account_id, role: "author", exp, csrf }, env.SESSION_SECRET);

    const headers = new Headers();
    headers.append("set-cookie", makeCookie(AUTHOR_COOKIE, session, {
      maxAgeSeconds: 60 * 60 * 12,
      path: "/api/vault/author",
      sameSite: "Lax"
    }));
    return json({ author_account_id: rows[0].author_account_id, author_id: rows[0].author_id, email: rows[0].email, csrf }, { headers });
  }

  // POST /api/vault/author/logout
  if (req.method === "POST" && url.pathname === "/api/vault/author/logout") {
    const headers = new Headers();
    headers.append("set-cookie", clearCookie(AUTHOR_COOKIE, { path: "/api/vault/author", sameSite: "Lax" }));
    return json({ ok: true }, { headers });
  }

  const session = await getAuthorSession(req, env);
  if (!session) return unauthorized("Author login required");

  // GET /api/vault/author/me
  if (req.method === "GET" && url.pathname === "/api/vault/author/me") {
    const rows = await db/*sql*/`
      SELECT id, author_id, email, display_name, status, created_at
      FROM author_portal_accounts
      WHERE id = ${session.sub}::uuid
      LIMIT 1;
    `;
    if (!rows.length) return unauthorized("Author account not found");
    return json({ me: rows[0], csrf: session.csrf });
  }

  // GET /api/vault/author/books  (books where this author is attached)
  if (req.method === "GET" && url.pathname === "/api/vault/author/books") {
    const rows = await db/*sql*/`
      SELECT b.id, b.title, b.slug, b.cover_url, b.published_year
      FROM author_portal_accounts apa
      JOIN book_authors ba ON ba.author_id = apa.author_id
      JOIN books b ON b.id = ba.book_id
      WHERE apa.id = ${session.sub}::uuid
      ORDER BY b.published_year DESC NULLS LAST, b.title ASC
      LIMIT 200;
    `;
    return json({ items: rows });
  }

  // POST /api/vault/author/submissions  (existing tags only)
  if (req.method === "POST" && url.pathname === "/api/vault/author/submissions") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    // Rate limit: 50 submissions per hour
    const rateCheck = await checkSubmissionRateLimit(env.RATE_LIMIT, session.sub);
    if (!rateCheck.allowed) {
      return tooManyRequests("Submission rate limit exceeded. Try again later.", rateCheck.resetIn);
    }

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = SubmitSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());
    const { book_id, tag_id, evidence } = parsed.data;

    // authz: author must be attached to book
    const authzCheck = await db/*sql*/`
      SELECT 1
      FROM author_portal_accounts apa
      JOIN book_authors ba ON ba.author_id = apa.author_id
      WHERE apa.id = ${session.sub}::uuid AND ba.book_id = ${book_id}::uuid
      LIMIT 1;
    `;
    if (!authzCheck.length) return forbidden("You are not an author on that book.");

    // tag must exist
    const tag = await db/*sql*/`SELECT id, category, slug, is_premium, sensitive_flag FROM tags WHERE id = ${tag_id}::uuid;`;
    if (!tag.length) return badRequest("Unknown tag_id");

    // Per-book limit: max 100 pending submissions per book per author
    const pendingCount = await db/*sql*/`
      SELECT COUNT(*) AS cnt FROM author_tag_submissions
      WHERE author_account_id = ${session.sub}::uuid
        AND book_id = ${book_id}::uuid
        AND status = 'pending';
    `;
    if (parseInt(pendingCount[0]?.cnt || "0", 10) >= 100) {
      return badRequest("Maximum pending submissions per book reached (100). Wait for review.");
    }

    try {
      const rows = await db/*sql*/`
        INSERT INTO author_tag_submissions (author_account_id, book_id, tag_id, evidence_json, status)
        VALUES (${session.sub}::uuid, ${book_id}::uuid, ${tag_id}::uuid, ${JSON.stringify(evidence)}::jsonb, 'pending')
        ON CONFLICT (author_account_id, book_id, tag_id)
        DO UPDATE SET evidence_json = EXCLUDED.evidence_json, status = 'pending', updated_at = NOW()
        RETURNING *;
      `;
      return json({ item: rows[0] }, { status: 201 });
    } catch (e: any) {
      return serverError("Failed to submit", { message: String(e?.message || e) });
    }
  }

  // GET /api/vault/author/submissions?status=pending|approved|rejected
  if (req.method === "GET" && url.pathname === "/api/vault/author/submissions") {
    const status = url.searchParams.get("status");
    const rows = await db/*sql*/`
      SELECT s.*, t.category, t.slug, t.name, b.title
      FROM author_tag_submissions s
      JOIN tags t ON t.id = s.tag_id
      JOIN books b ON b.id = s.book_id
      WHERE s.author_account_id = ${session.sub}::uuid
      ${status ? db/*sql*/`AND s.status = ${status}` : db/*sql*/``}
      ORDER BY s.created_at DESC
      LIMIT 200;
    `;
    return json({ items: rows });
  }

  // POST /api/vault/author/book-intake  (full book intake submission)
  if (req.method === "POST" && url.pathname === "/api/vault/author/book-intake") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    // Rate limit: 10 book intakes per hour
    const rateCheck = await checkBookIntakeRateLimit(env.RATE_LIMIT, session.sub);
    if (!rateCheck.allowed) {
      return tooManyRequests("Book intake rate limit exceeded. Try again later.", rateCheck.resetIn);
    }

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = BookIntakeSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    const data = parsed.data;

    // Check for duplicate ASIN from same author (pending or approved)
    const existingAsin = await db/*sql*/`
      SELECT id, status FROM author_book_intakes
      WHERE author_account_id = ${session.sub}::uuid
        AND asin = ${data.asin}
        AND status IN ('pending', 'approved')
      LIMIT 1;
    `;
    if (existingAsin.length) {
      return badRequest(`You already have a ${existingAsin[0].status} intake for this ASIN.`);
    }

    // Validate all tag_ids exist and belong to expected categories
    const allTagIds = new Set<string>();
    allTagIds.add(data.world_framework);
    allTagIds.add(data.pairing);
    allTagIds.add(data.heat_level);
    allTagIds.add(data.series_status);
    allTagIds.add(data.consent_mode);
    data.content_warnings.forEach(t => allTagIds.add(t.tag_id));
    data.tropes.forEach(t => allTagIds.add(t.tag_id));
    data.hero_archetypes.forEach(id => allTagIds.add(id));
    data.heroine_archetypes.forEach(id => allTagIds.add(id));
    data.representation.forEach(t => allTagIds.add(t.tag_id));
    data.kink_bundles.forEach(id => allTagIds.add(id));
    data.kink_details.forEach(t => allTagIds.add(t.tag_id));

    const tagIdArray = [...allTagIds];
    const validTags = await db/*sql*/`
      SELECT id, category, slug FROM tags WHERE id = ANY(${tagIdArray}::uuid[]);
    `;
    const validTagIds = new Set(validTags.map((t: any) => t.id));
    const invalidIds = tagIdArray.filter(id => !validTagIds.has(id));
    if (invalidIds.length) {
      return badRequest("Invalid tag IDs", { invalid_tag_ids: invalidIds });
    }

    // Build the intake payload JSON
    const intakePayload = {
      title: data.title,
      asin: data.asin,
      series_name: data.series_name || null,
      series_number: data.series_number || null,
      publication_date: data.publication_date || null,
      axes: {
        world_framework: data.world_framework,
        pairing: data.pairing,
        heat_level: data.heat_level,
        series_status: data.series_status,
        consent_mode: data.consent_mode,
      },
      content_warnings: data.content_warnings,
      tropes: data.tropes,
      hero_archetypes: data.hero_archetypes,
      heroine_archetypes: data.heroine_archetypes,
      representation: data.representation,
      kink_bundles: data.kink_bundles,
      kink_details: data.kink_details,
      notes: data.notes || null,
    };

    try {
      const rows = await db/*sql*/`
        INSERT INTO author_book_intakes (author_account_id, asin, intake_json, status)
        VALUES (${session.sub}::uuid, ${data.asin}, ${JSON.stringify(intakePayload)}::jsonb, 'pending')
        RETURNING id, asin, status, created_at;
      `;
      return json({ item: rows[0] }, { status: 201 });
    } catch (e: any) {
      return serverError("Failed to submit book intake", { message: String(e?.message || e) });
    }
  }

  // GET /api/vault/author/book-intakes?status=pending|approved|rejected
  if (req.method === "GET" && url.pathname === "/api/vault/author/book-intakes") {
    const status = url.searchParams.get("status");
    const rows = await db/*sql*/`
      SELECT id, asin, intake_json->>'title' AS title, status, created_at, updated_at, admin_notes
      FROM author_book_intakes
      WHERE author_account_id = ${session.sub}::uuid
      ${status ? db/*sql*/`AND status = ${status}` : db/*sql*/``}
      ORDER BY created_at DESC
      LIMIT 100;
    `;
    return json({ items: rows });
  }

  return notFound("Unknown author route");
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(hash);
  return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}
