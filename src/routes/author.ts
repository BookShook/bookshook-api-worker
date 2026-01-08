import { z } from "zod";
import type { Env } from "../db";
import { getDb } from "../db";
import { json, badRequest, unauthorized, forbidden, notFound, serverError } from "../lib/respond";
import { parseCookies, verifySession, signSession, makeCookie, clearCookie, randomToken } from "../security/session";
import { requireCsrf } from "../security/csrf";

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

async function getAuthorSession(req: Request, env: Env) {
  const cookies = parseCookies(req);
  const raw = cookies[AUTHOR_COOKIE];
  if (!raw) return null;
  return await verifySession(raw, env.SESSION_SECRET);
}

export async function handleAuthor(req: Request, env: Env) {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/author/")) return null;

  const db = getDb(env);

  // POST /api/author/login  (one-time invite token)
  if (req.method === "POST" && url.pathname === "/api/author/login") {
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
    if (!rows.length) return unauthorized("Invalid or expired token");
    if (rows[0].status !== "active") return forbidden("Account not active");
    if (new Date(rows[0].expires_at).getTime() < Date.now()) return unauthorized("Token expired");

    // one-time use
    await db/*sql*/`DELETE FROM author_portal_tokens WHERE token_hash = ${tokenHash};`;

    const csrf = randomToken(18);
    const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 12; // 12h
    const session = await signSession({ sub: rows[0].author_account_id, role: "author", exp, csrf }, env.SESSION_SECRET);

    const headers = new Headers();
    headers.append("set-cookie", makeCookie(AUTHOR_COOKIE, session, { maxAgeSeconds: 60 * 60 * 12 }));
    return json({ author_account_id: rows[0].author_account_id, author_id: rows[0].author_id, email: rows[0].email, csrf }, { headers });
  }

  // POST /api/author/logout
  if (req.method === "POST" && url.pathname === "/api/author/logout") {
    const headers = new Headers();
    headers.append("set-cookie", clearCookie(AUTHOR_COOKIE));
    return json({ ok: true }, { headers });
  }

  const session = await getAuthorSession(req, env);
  if (!session) return unauthorized("Author login required");

  // GET /api/author/me
  if (req.method === "GET" && url.pathname === "/api/author/me") {
    const rows = await db/*sql*/`
      SELECT id, author_id, email, display_name, status, created_at
      FROM author_portal_accounts
      WHERE id = ${session.sub}::uuid
      LIMIT 1;
    `;
    if (!rows.length) return unauthorized("Author account not found");
    return json({ me: rows[0], csrf: session.csrf });
  }

  // GET /api/author/books  (books where this author is attached)
  if (req.method === "GET" && url.pathname === "/api/author/books") {
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

  // POST /api/author/submissions  (existing tags only)
  if (req.method === "POST" && url.pathname === "/api/author/submissions") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = SubmitSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());
    const { book_id, tag_id, evidence } = parsed.data;

    // authz: author must be attached to book
    const ok = await db/*sql*/`
      SELECT 1
      FROM author_portal_accounts apa
      JOIN book_authors ba ON ba.author_id = apa.author_id
      WHERE apa.id = ${session.sub}::uuid AND ba.book_id = ${book_id}::uuid
      LIMIT 1;
    `;
    if (!ok.length) return forbidden("You are not an author on that book.");

    // tag must exist
    const tag = await db/*sql*/`SELECT id, category, slug, is_premium, sensitive_flag FROM tags WHERE id = ${tag_id}::uuid;`;
    if (!tag.length) return badRequest("Unknown tag_id");

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

  // GET /api/author/submissions?status=pending|approved|rejected
  if (req.method === "GET" && url.pathname === "/api/author/submissions") {
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

  return notFound("Unknown author route");
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(hash);
  return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}
