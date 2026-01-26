import { z } from "zod";
import type { Env } from "../db";
import { getDb } from "../db";
import { json, badRequest, unauthorized, forbidden, notFound, serverError, tooManyRequests } from "../lib/respond";
import { verifyPbkdf2Password } from "../security/pbkdf2";
import { parseCookies, verifySession, signSession, makeCookie, clearCookie, randomToken, checkSessionRevoked, revokeAllSessions, generateJti } from "../security/session";
import { requireCsrf } from "../security/csrf";
import { slugify } from "../security/slugify";
import { checkLoginRateLimit, rateLimitResponse } from "../security/ratelimit";
import { validateOrigin } from "../security/origin";

const ADMIN_COOKIE = "bh_admin";

const LoginSchema = z.object({ password: z.string().min(8).max(200) });

// Category caps for validation
const CATEGORY_CAPS: Record<string, number> = {
  trope: 8,
  plot_engine: 2,
  setting_wrapper: 2,
  seasonal_wrapper: 1,
};

// High-stakes tags that require evidence
const HIGH_STAKES_CATEGORIES = ['content_warning'];

// Compute validation status for a book
async function computeValidation(
  db: any,
  bookId: string,
  axes: any,
  tags: Record<string, any[]>,
  evidence: any[],
  assets: any
) {
  const gates: { id: string; ok: boolean; missing?: string[] }[] = [];
  const contradictions: { ruleId: string; severity: string; message: string }[] = [];
  const caps: { category: string; count: number; max: number; ok: boolean }[] = [];

  // Required axes check
  const requiredAxes = ['worldFramework', 'pairing', 'heatLevel', 'seriesStatus', 'consentMode'];
  const missingAxes = requiredAxes.filter(a => !axes[a]);
  gates.push({
    id: 'REQ_AXES',
    ok: missingAxes.length === 0,
    missing: missingAxes.length > 0 ? missingAxes : undefined,
  });

  // Cover check
  gates.push({
    id: 'REQ_COVER',
    ok: assets.cover?.state === 'ready',
  });

  // Cap checks
  for (const [category, max] of Object.entries(CATEGORY_CAPS)) {
    const count = tags[category]?.length || 0;
    caps.push({ category, count, max, ok: count <= max });
  }

  // Evidence check for high-stakes tags
  const highStakesTags = Object.values(tags).flat().filter((t: any) => t.requiresEvidence);
  const tagsWithoutEvidence = highStakesTags.filter((t: any) => {
    return !evidence.some((e: any) =>
      e.links?.some((l: any) => l.targetType === 'tag' && l.targetId === t.id)
    );
  });

  if (tagsWithoutEvidence.length > 0) {
    gates.push({
      id: 'REQ_EVIDENCE',
      ok: false,
      missing: tagsWithoutEvidence.map((t: any) => t.name),
    });
  } else if (highStakesTags.length > 0) {
    gates.push({ id: 'REQ_EVIDENCE', ok: true });
  }

  // Contradiction: consent mode vs warnings
  if (axes.consentMode) {
    const consentTag = await db/*sql*/`SELECT slug FROM tags WHERE id = ${axes.consentMode}::uuid;`;
    const consentSlug = consentTag[0]?.slug;

    const hasNonCon = tags.content_warning?.some((t: any) =>
      ['non-consent', 'noncon', 'dubious-consent', 'dubcon', 'sexual-assault'].includes(t.slug)
    );

    if (['clear-explicit', 'negotiated'].includes(consentSlug) && hasNonCon) {
      contradictions.push({
        ruleId: 'CONSENT_WARNING_MISMATCH',
        severity: 'hard',
        message: 'Consent Mode conflicts with Non-Consent/Dubious Consent/SA warnings',
      });
    }
  }

  // Queue flags
  const queues = {
    unfinished: gates.some(g => !g.ok && g.id === 'REQ_AXES') || !assets.cover,
    needsEvidence: gates.some(g => !g.ok && g.id === 'REQ_EVIDENCE'),
    contradiction: contradictions.some(c => c.severity === 'hard'),
  };

  return { gates, contradictions, caps, queues };
}

// Basic session verification (no revocation check - use sparingly)
async function getAdminSessionBasic(req: Request, env: Env) {
  const cookies = parseCookies(req);
  const raw = cookies[ADMIN_COOKIE];
  if (!raw) return null;
  const session = await verifySession(raw, env.SESSION_SECRET);
  if (!session || session.role !== "curator") return null;
  return session;
}

// Full session verification WITH revocation check (use for all protected routes)
// db parameter is required to enforce revocation checking
async function requireAdminSession(req: Request, env: Env, db: any): Promise<{
  session: NonNullable<Awaited<ReturnType<typeof verifySession>>>;
} | { error: Response }> {
  const cookies = parseCookies(req);
  const raw = cookies[ADMIN_COOKIE];
  if (!raw) return { error: unauthorized("Admin login required") };

  const session = await verifySession(raw, env.SESSION_SECRET);
  if (!session || session.role !== "curator") {
    return { error: unauthorized("Admin login required") };
  }

  // Always check revocation for sessions with jti or iat
  if (session.jti || session.iat) {
    const revocationCheck = await checkSessionRevoked(db, session);
    if (revocationCheck.revoked) {
      return { error: unauthorized("Session revoked: " + (revocationCheck.reason || "Please log in again")) };
    }
  }

  return { session };
}

export async function handleAdmin(req: Request, env: Env) {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/vault/admin/")) return null;

  const db = getDb(env);
  const clientIp = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";

  // Origin check for all mutation requests
  if (!validateOrigin(req, env.SITE_ORIGIN)) {
    return forbidden("Invalid origin");
  }

  // POST /api/vault/admin/login
  if (req.method === "POST" && url.pathname === "/api/vault/admin/login") {
    try {
      // Rate limit: 5 attempts per 15 minutes
      const rateCheck = await checkLoginRateLimit(env.RATE_LIMIT, clientIp, "admin");
      if (!rateCheck.allowed) {
        return rateLimitResponse(rateCheck);
      }

      let body: unknown;
      try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
      const parsed = LoginSchema.safeParse(body);
      if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

      // Check if secrets are set
      if (!env.ADMIN_PBKDF2_SALT || !env.ADMIN_PBKDF2_HASH || !env.SESSION_SECRET) {
        return serverError("Admin secrets not configured", {
          hasSalt: !!env.ADMIN_PBKDF2_SALT,
          hasHash: !!env.ADMIN_PBKDF2_HASH,
          hasSession: !!env.SESSION_SECRET
        });
      }

      const iters = parseInt(env.ADMIN_PBKDF2_ITERS || "100000", 10);
      const ok = await verifyPbkdf2Password(parsed.data.password, env.ADMIN_PBKDF2_SALT, env.ADMIN_PBKDF2_HASH, iters);
      if (!ok) return unauthorized("Invalid credentials");

      const csrf = randomToken(18);
      const jti = generateJti();  // Unique session ID for revocation
      const iat = Math.floor(Date.now() / 1000);  // Issued at
      const exp = iat + 60 * 60 * 12; // 12h from now
      const token = await signSession({ sub: "curator", role: "curator", exp, iat, jti, csrf }, env.SESSION_SECRET);

      const headers = new Headers();
      headers.append("set-cookie", makeCookie(ADMIN_COOKIE, token, {
        maxAgeSeconds: 60 * 60 * 12,
        path: "/api/vault/admin",
        sameSite: "Lax"
      }));
      return json({ ok: true, csrf }, { headers });
    } catch (e: any) {
      return serverError("Login error", { message: String(e?.message || e) });
    }
  }

  // POST /api/vault/admin/logout
  if (req.method === "POST" && url.pathname === "/api/vault/admin/logout") {
    const headers = new Headers();
    headers.append("set-cookie", clearCookie(ADMIN_COOKIE, { path: "/api/vault/admin", sameSite: "Lax" }));
    return json({ ok: true }, { headers });
  }

  // ========================================================================
  // ALL ROUTES BELOW REQUIRE AUTHENTICATED SESSION WITH REVOCATION CHECK
  // ========================================================================
  const authResult = await requireAdminSession(req, env, db);
  if ('error' in authResult) return authResult.error;
  const session = authResult.session;

  // POST /api/vault/admin/logout-all - revoke all sessions for this subject
  if (req.method === "POST" && url.pathname === "/api/vault/admin/logout-all") {
    const csrfToken = req.headers.get("x-csrf-token");
    if (!csrfToken || csrfToken !== session.csrf) {
      return forbidden("CSRF token mismatch");
    }

    await revokeAllSessions(db, session.sub, session.sub, "User requested logout all devices");

    const headers = new Headers();
    headers.append("set-cookie", clearCookie(ADMIN_COOKIE, { path: "/api/vault/admin", sameSite: "Lax" }));
    return json({ ok: true, message: "All sessions revoked" }, { headers });
  }

  // GET /api/vault/admin/proposals?status=pending|eligible
  if (req.method === "GET" && url.pathname === "/api/vault/admin/proposals") {
    const status = url.searchParams.get("status") ?? "pending";
    const minVotes = parseInt(url.searchParams.get("min_votes") ?? "20", 10) || 20;
    const minRatio = parseFloat(url.searchParams.get("min_ratio") ?? "0.75") || 0.75;

    const rows = await db/*sql*/`
      SELECT p.*,
             v.upvotes, v.downvotes, v.total_votes, v.upvote_ratio,
             t.name AS existing_tag_name, t.category AS existing_tag_category,
             b.title AS book_title
      FROM tag_proposals p
      LEFT JOIN proposal_vote_totals v ON v.id = p.id
      LEFT JOIN tags t ON t.id = p.existing_tag_id
      LEFT JOIN books b ON b.id = p.book_id
      WHERE p.status = ${status}
      ORDER BY p.created_at DESC
      LIMIT 200;
    `;

    const eligible = rows.filter((r: any) => (r.total_votes ?? 0) >= minVotes && (r.upvote_ratio ?? 0) >= minRatio);
    return json({ items: rows, eligible_preview: eligible, threshold: { minVotes, minRatio } });
  }

  const ApproveSchema = z.object({
    action: z.enum(["approve", "reject"]),
    rejection_reason: z.string().max(500).optional(),
  });

  // POST /api/vault/admin/proposals/:id/decide
  const decideMatch = url.pathname.match(/^\/api\/vault\/admin\/proposals\/([0-9a-fA-F-]{36})\/decide$/);
  if (decideMatch && req.method === "POST") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = ApproveSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    const proposalId = decideMatch[1];
    const proposalRows = await db/*sql*/`SELECT * FROM tag_proposals WHERE id = ${proposalId}::uuid;`;
    if (!proposalRows.length) return notFound("Proposal not found");
    const proposal = proposalRows[0];

    if (parsed.data.action === "reject") {
      await db/*sql*/`
        UPDATE tag_proposals
        SET status='rejected',
            rejection_reason=${parsed.data.rejection_reason ?? "Rejected"},
            decided_by=${session.sub},
            decided_at=NOW(),
            updated_at=NOW()
        WHERE id=${proposalId}::uuid;
      `;
      return json({ ok: true, status: "rejected" });
    }

    // approve
    try {
      if (proposal.proposal_type === "assign_existing") {
        await db/*sql*/`
          INSERT INTO book_tags (book_id, tag_id)
          VALUES (${proposal.book_id}::uuid, ${proposal.existing_tag_id}::uuid)
          ON CONFLICT (book_id, tag_id) DO NOTHING;
        `;
      } else if (proposal.proposal_type === "create_new") {
        const newSlug = proposal.proposed_slug || slugify(proposal.proposed_name || "");
        const inserted = await db/*sql*/`
          INSERT INTO tags (category, name, slug, description, parent_tag_id, sensitive_flag, is_premium, display_order)
          VALUES (
            ${proposal.proposed_category_key},
            ${proposal.proposed_name},
            ${newSlug},
            NULL,
            NULL,
            FALSE,
            FALSE,
            0
          )
          ON CONFLICT (category, slug) DO UPDATE SET name = EXCLUDED.name
          RETURNING id;
        `;
        const tagId = inserted[0].id;
        if (proposal.book_id) {
          await db/*sql*/`
            INSERT INTO book_tags (book_id, tag_id)
            VALUES (${proposal.book_id}::uuid, ${tagId}::uuid)
            ON CONFLICT (book_id, tag_id) DO NOTHING;
          `;
        }
      }

      await db/*sql*/`
        UPDATE tag_proposals
        SET status='approved',
            decided_by=${session.sub},
            decided_at=NOW(),
            updated_at=NOW()
        WHERE id=${proposalId}::uuid;
      `;
      return json({ ok: true, status: "approved" });
    } catch (e: any) {
      return serverError("Approve failed", { message: String(e?.message || e) });
    }
  }

  // ------------------------------------------------------------------
  // Author portal: invite tokens + review submissions
  // ------------------------------------------------------------------

  const InviteSchema = z.object({
    author_id: z.string().uuid(),
    email: z.string().email(),
    display_name: z.string().max(120).optional(),
    expires_hours: z.number().int().min(1).max(168).optional(), // up to 7 days
  });

  // POST /api/vault/admin/authors/invite  -> returns one-time token (you send it)
  if (req.method === "POST" && url.pathname === "/api/vault/admin/authors/invite") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = InviteSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    const token = randomToken(24);
    const tokenHash = await sha256Hex(token);
    const hours = parsed.data.expires_hours ?? 72;

    // upsert account
    const acct = await db/*sql*/`
      INSERT INTO author_portal_accounts (author_id, email, display_name, status)
      VALUES (${parsed.data.author_id}::uuid, ${parsed.data.email}, ${parsed.data.display_name ?? null}, 'active')
      ON CONFLICT (email) DO UPDATE SET author_id = EXCLUDED.author_id, display_name = COALESCE(EXCLUDED.display_name, author_portal_accounts.display_name)
      RETURNING id;
    `;

    await db/*sql*/`
      INSERT INTO author_portal_tokens (token_hash, author_account_id, expires_at)
      VALUES (${tokenHash}, ${acct[0].id}::uuid, NOW() + (${hours} || ' hours')::interval)
      ON CONFLICT (token_hash) DO NOTHING;
    `;

    return json({ token, expires_hours: hours, author_account_id: acct[0].id });
  }

  // GET /api/vault/admin/author-submissions?status=pending
  if (req.method === "GET" && url.pathname === "/api/vault/admin/author-submissions") {
    const status = url.searchParams.get("status") ?? "pending";
    const rows = await db/*sql*/`
      SELECT s.*, t.category, t.slug, t.name AS tag_name, b.title, a.name AS author_name
      FROM author_tag_submissions s
      JOIN tags t ON t.id = s.tag_id
      JOIN books b ON b.id = s.book_id
      JOIN author_portal_accounts apa ON apa.id = s.author_account_id
      JOIN authors a ON a.id = apa.author_id
      WHERE s.status = ${status}
      ORDER BY s.created_at ASC
      LIMIT 200;
    `;
    return json({ items: rows });
  }

  const DecideSubmissionSchema = z.object({
    action: z.enum(["approve", "reject"]),
    reviewer_notes: z.string().max(500).optional(),
  });

  // POST /api/vault/admin/author-submissions/:id/decide
  const subDecideMatch = url.pathname.match(/^\/api\/vault\/admin\/author-submissions\/([0-9a-fA-F-]{36})\/decide$/);
  if (subDecideMatch && req.method === "POST") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = DecideSubmissionSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    const submissionId = subDecideMatch[1];
    const rows = await db/*sql*/`SELECT * FROM author_tag_submissions WHERE id = ${submissionId}::uuid;`;
    if (!rows.length) return notFound("Submission not found");
    const sub = rows[0];

    if (parsed.data.action === "reject") {
      await db/*sql*/`
        UPDATE author_tag_submissions
        SET status='rejected',
            reviewer_notes=${parsed.data.reviewer_notes ?? "Rejected"},
            decided_by=${session.sub},
            decided_at=NOW(),
            updated_at=NOW()
        WHERE id=${submissionId}::uuid;
      `;
      return json({ ok: true, status: "rejected" });
    }

    try {
      // apply tag to book
      await db/*sql*/`
        INSERT INTO book_tags (book_id, tag_id)
        VALUES (${sub.book_id}::uuid, ${sub.tag_id}::uuid)
        ON CONFLICT (book_id, tag_id) DO NOTHING;
      `;

      await db/*sql*/`
        UPDATE author_tag_submissions
        SET status='approved',
            reviewer_notes=${parsed.data.reviewer_notes ?? null},
            decided_by=${session.sub},
            decided_at=NOW(),
            updated_at=NOW()
        WHERE id=${submissionId}::uuid;
      `;

      return json({ ok: true, status: "approved" });
    } catch (e: any) {
      return serverError("Approve submission failed", { message: String(e?.message || e) });
    }
  }

  // ------------------------------------------------------------------
  // Collections CRUD
  // ------------------------------------------------------------------

  // GET /api/vault/admin/collections
  if (req.method === "GET" && url.pathname === "/api/vault/admin/collections") {
    const rows = await db/*sql*/`
      SELECT
        c.id::text AS id,
        c.slug,
        c.title,
        c.description,
        c.cover_url,
        c.is_published,
        c.display_order,
        c.created_at,
        c.updated_at,
        COALESCE(COUNT(cb.book_id), 0)::int AS book_count
      FROM collections c
      LEFT JOIN collection_books cb ON cb.collection_id = c.id
      GROUP BY c.id
      ORDER BY c.display_order ASC, c.title ASC
      LIMIT 200;
    `;
    return json({ items: rows });
  }

  // GET /api/vault/admin/collections/:id
  const collectionDetailMatch = url.pathname.match(/^\/api\/vault\/admin\/collections\/([0-9a-fA-F-]{36})$/);
  if (collectionDetailMatch && req.method === "GET") {
    const collectionId = collectionDetailMatch[1];
    const colRows = await db/*sql*/`
      SELECT id::text AS id, slug, title, description, cover_url, is_published, display_order, created_at, updated_at
      FROM collections WHERE id = ${collectionId}::uuid;
    `;
    if (!colRows.length) return notFound("Collection not found");

    const bookRows = await db/*sql*/`
      SELECT
        b.id::text AS id, b.slug, b.title, b.cover_url,
        cb.book_order
      FROM collection_books cb
      JOIN books b ON b.id = cb.book_id
      WHERE cb.collection_id = ${collectionId}::uuid
      ORDER BY cb.book_order ASC;
    `;

    return json({ collection: colRows[0], books: bookRows });
  }

  const CreateCollectionSchema = z.object({
    title: z.string().min(1).max(200),
    slug: z.string().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
    description: z.string().max(1000).optional(),
    cover_url: z.string().url().optional(),
    is_published: z.boolean().optional(),
    display_order: z.number().int().optional(),
  });

  // POST /api/vault/admin/collections
  if (req.method === "POST" && url.pathname === "/api/vault/admin/collections") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = CreateCollectionSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    const slug = parsed.data.slug || slugify(parsed.data.title);

    try {
      const rows = await db/*sql*/`
        INSERT INTO collections (slug, title, description, cover_url, is_published, display_order)
        VALUES (
          ${slug},
          ${parsed.data.title},
          ${parsed.data.description ?? null},
          ${parsed.data.cover_url ?? null},
          ${parsed.data.is_published ?? false},
          ${parsed.data.display_order ?? 0}
        )
        RETURNING id::text AS id, slug, title;
      `;
      return json({ ok: true, collection: rows[0] });
    } catch (e: any) {
      if (e.message?.includes("unique") || e.message?.includes("duplicate")) {
        return badRequest("Collection with this slug already exists");
      }
      return serverError("Failed to create collection", { message: String(e?.message || e) });
    }
  }

  const UpdateCollectionSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    slug: z.string().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
    description: z.string().max(1000).nullable().optional(),
    cover_url: z.string().url().nullable().optional(),
    is_published: z.boolean().optional(),
    display_order: z.number().int().optional(),
  });

  // PUT /api/vault/admin/collections/:id
  if (collectionDetailMatch && req.method === "PUT") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const collectionId = collectionDetailMatch[1];

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = UpdateCollectionSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    // Build dynamic update query
    const updates: string[] = [];
    const values: any[] = [];

    if (parsed.data.title !== undefined) {
      updates.push("title");
      values.push(parsed.data.title);
    }
    if (parsed.data.slug !== undefined) {
      updates.push("slug");
      values.push(parsed.data.slug);
    }
    if (parsed.data.description !== undefined) {
      updates.push("description");
      values.push(parsed.data.description);
    }
    if (parsed.data.cover_url !== undefined) {
      updates.push("cover_url");
      values.push(parsed.data.cover_url);
    }
    if (parsed.data.is_published !== undefined) {
      updates.push("is_published");
      values.push(parsed.data.is_published);
    }
    if (parsed.data.display_order !== undefined) {
      updates.push("display_order");
      values.push(parsed.data.display_order);
    }

    if (updates.length === 0) {
      return badRequest("No fields to update");
    }

    try {
      // Using a simple approach with individual updates
      if (parsed.data.title !== undefined) {
        await db/*sql*/`UPDATE collections SET title = ${parsed.data.title}, updated_at = NOW() WHERE id = ${collectionId}::uuid;`;
      }
      if (parsed.data.slug !== undefined) {
        await db/*sql*/`UPDATE collections SET slug = ${parsed.data.slug}, updated_at = NOW() WHERE id = ${collectionId}::uuid;`;
      }
      if (parsed.data.description !== undefined) {
        await db/*sql*/`UPDATE collections SET description = ${parsed.data.description}, updated_at = NOW() WHERE id = ${collectionId}::uuid;`;
      }
      if (parsed.data.cover_url !== undefined) {
        await db/*sql*/`UPDATE collections SET cover_url = ${parsed.data.cover_url}, updated_at = NOW() WHERE id = ${collectionId}::uuid;`;
      }
      if (parsed.data.is_published !== undefined) {
        await db/*sql*/`UPDATE collections SET is_published = ${parsed.data.is_published}, updated_at = NOW() WHERE id = ${collectionId}::uuid;`;
      }
      if (parsed.data.display_order !== undefined) {
        await db/*sql*/`UPDATE collections SET display_order = ${parsed.data.display_order}, updated_at = NOW() WHERE id = ${collectionId}::uuid;`;
      }

      return json({ ok: true });
    } catch (e: any) {
      return serverError("Failed to update collection", { message: String(e?.message || e) });
    }
  }

  // DELETE /api/vault/admin/collections/:id
  if (collectionDetailMatch && req.method === "DELETE") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const collectionId = collectionDetailMatch[1];

    try {
      await db/*sql*/`DELETE FROM collections WHERE id = ${collectionId}::uuid;`;
      return json({ ok: true });
    } catch (e: any) {
      return serverError("Failed to delete collection", { message: String(e?.message || e) });
    }
  }

  const AddBookSchema = z.object({
    book_id: z.string().uuid(),
    book_order: z.number().int().min(0).optional(),
  });

  // POST /api/vault/admin/collections/:id/books - add book to collection
  const addBookMatch = url.pathname.match(/^\/api\/vault\/admin\/collections\/([0-9a-fA-F-]{36})\/books$/);
  if (addBookMatch && req.method === "POST") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const collectionId = addBookMatch[1];

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = AddBookSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    try {
      // Get next order if not specified
      let order = parsed.data.book_order;
      if (order === undefined) {
        const maxRows = await db/*sql*/`
          SELECT COALESCE(MAX(book_order), 0) + 1 AS next_order
          FROM collection_books WHERE collection_id = ${collectionId}::uuid;
        `;
        order = maxRows[0]?.next_order ?? 1;
      }

      await db/*sql*/`
        INSERT INTO collection_books (collection_id, book_id, book_order)
        VALUES (${collectionId}::uuid, ${parsed.data.book_id}::uuid, ${order})
        ON CONFLICT (collection_id, book_id) DO UPDATE SET book_order = EXCLUDED.book_order;
      `;
      return json({ ok: true, book_order: order });
    } catch (e: any) {
      return serverError("Failed to add book to collection", { message: String(e?.message || e) });
    }
  }

  // DELETE /api/vault/admin/collections/:id/books/:bookId - remove book from collection
  const removeBookMatch = url.pathname.match(/^\/api\/vault\/admin\/collections\/([0-9a-fA-F-]{36})\/books\/([0-9a-fA-F-]{36})$/);
  if (removeBookMatch && req.method === "DELETE") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const collectionId = removeBookMatch[1];
    const bookId = removeBookMatch[2];

    try {
      await db/*sql*/`
        DELETE FROM collection_books
        WHERE collection_id = ${collectionId}::uuid AND book_id = ${bookId}::uuid;
      `;
      return json({ ok: true });
    } catch (e: any) {
      return serverError("Failed to remove book from collection", { message: String(e?.message || e) });
    }
  }

  // PUT /api/vault/admin/collections/:id/books/reorder - reorder books
  const reorderMatch = url.pathname.match(/^\/api\/vault\/admin\/collections\/([0-9a-fA-F-]{36})\/books\/reorder$/);
  if (reorderMatch && req.method === "PUT") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const collectionId = reorderMatch[1];

    const ReorderSchema = z.object({
      book_ids: z.array(z.string().uuid()), // ordered list of book IDs
    });

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = ReorderSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    try {
      // Update each book's order
      for (let i = 0; i < parsed.data.book_ids.length; i++) {
        await db/*sql*/`
          UPDATE collection_books
          SET book_order = ${i + 1}
          WHERE collection_id = ${collectionId}::uuid AND book_id = ${parsed.data.book_ids[i]}::uuid;
        `;
      }
      return json({ ok: true });
    } catch (e: any) {
      return serverError("Failed to reorder books", { message: String(e?.message || e) });
    }
  }

  // GET /api/vault/admin/books/search?q=... - search books to add to collection
  if (req.method === "GET" && url.pathname === "/api/vault/admin/books/search") {
    const q = url.searchParams.get("q") ?? "";
    if (q.length < 2) return json({ items: [] });

    const rows = await db/*sql*/`
      SELECT id::text AS id, slug, title, cover_url
      FROM books
      WHERE title ILIKE ${'%' + q + '%'}
      ORDER BY title ASC
      LIMIT 20;
    `;
    return json({ items: rows });
  }

  // ------------------------------------------------------------------
  // Book Creation (hardened)
  // ------------------------------------------------------------------

  // Helper: normalize ASIN (uppercase, trim, validate)
  function normalizeAsin(asin: string | undefined): string | null {
    if (!asin) return null;
    const cleaned = asin.trim().toUpperCase().replace(/\s+/g, '');
    // ASIN is 10 alphanumeric chars (starts with B for Kindle, or 10 digits for ISBN-10)
    if (!/^[A-Z0-9]{10}$/.test(cleaned)) return null;
    return cleaned;
  }

  // Helper: normalize title for comparison (lowercase, remove punctuation, articles, etc.)
  function normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/^(the|a|an)\s+/i, '') // remove leading articles
      .replace(/\s*\([^)]*\)\s*/g, '') // remove parentheticals like "(A Novel)"
      .replace(/[^\w\s]/g, '') // remove punctuation
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Helper: normalize author name for comparison
  function normalizeAuthorName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // POST /api/vault/admin/books - create new book
  if (req.method === "POST" && url.pathname === "/api/vault/admin/books") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    // Idempotency key support
    const idempotencyKey = req.headers.get("idempotency-key");
    if (idempotencyKey && env.RATE_LIMIT) {
      const cached = await env.RATE_LIMIT.get(`idem:book:${idempotencyKey}`);
      if (cached) {
        return json(JSON.parse(cached));
      }
    }

    const CreateBookSchema = z.object({
      title: z.string().min(1).max(500),
      author_name: z.string().min(1).max(300).optional(),
      asin: z.string().max(20).optional(),
      isbn13: z.string().max(20).optional(),
      force_reason: z.string().max(500).optional(), // required when force=true with duplicates
    });

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = CreateBookSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    const { title, author_name, isbn13, force_reason } = parsed.data;

    // Normalize and validate ASIN
    const asin = normalizeAsin(parsed.data.asin);
    if (parsed.data.asin && !asin) {
      return badRequest("Invalid ASIN format. Must be 10 alphanumeric characters (e.g., B0XXXXXXXXX).");
    }

    // Normalize title and author for duplicate detection
    const titleNormalized = normalizeTitle(title);
    const authorNormalized = author_name ? normalizeAuthorName(author_name) : null;

    // Generate slug from title (stable, never changes after creation)
    const baseSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 100);

    // ------------------------------------------------------------------
    // Tiered duplicate detection
    // ------------------------------------------------------------------
    interface Duplicate {
      book_id: string;
      title: string;
      author?: string;
      asin?: string;
      status: string;
      confidence: 'high' | 'medium' | 'low';
      match_reason: string;
    }
    const duplicates: Duplicate[] = [];

    // Tier 1: ASIN exact match (HIGH confidence)
    if (asin) {
      const asinDupes = await db/*sql*/`
        SELECT b.id::text AS book_id, b.title, b.status, bi.asin,
               (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id LIMIT 1) AS author
        FROM books b
        JOIN book_identifiers bi ON bi.book_id = b.id
        WHERE bi.asin = ${asin};
      `;
      for (const d of asinDupes) {
        duplicates.push({
          book_id: d.book_id,
          title: d.title,
          author: d.author,
          asin: d.asin,
          status: d.status,
          confidence: 'high',
          match_reason: 'asin_exact',
        });
      }
    }

    // Tier 2: Normalized title + author exact match (MEDIUM-HIGH confidence)
    if (authorNormalized) {
      const titleAuthorDupes = await db/*sql*/`
        SELECT b.id::text AS book_id, b.title, b.status,
               a.name AS author
        FROM books b
        JOIN book_authors ba ON ba.book_id = b.id
        JOIN authors a ON a.id = ba.author_id
        WHERE LOWER(REGEXP_REPLACE(REGEXP_REPLACE(b.title, '^(the|a|an)\\s+', '', 'i'), '[^\\w\\s]', '', 'g')) = ${titleNormalized}
          AND LOWER(REGEXP_REPLACE(a.name, '[^\\w\\s]', '', 'g')) = ${authorNormalized}
        LIMIT 5;
      `;
      for (const d of titleAuthorDupes) {
        // Skip if already found by ASIN
        if (!duplicates.some(x => x.book_id === d.book_id)) {
          duplicates.push({
            book_id: d.book_id,
            title: d.title,
            author: d.author,
            status: d.status,
            confidence: 'medium',
            match_reason: 'title_author_normalized',
          });
        }
      }
    }

    // Tier 3: Exact title match (MEDIUM confidence)
    const exactTitleDupes = await db/*sql*/`
      SELECT b.id::text AS book_id, b.title, b.status,
             (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id LIMIT 1) AS author
      FROM books b
      WHERE LOWER(title) = LOWER(${title})
      LIMIT 5;
    `;
    for (const d of exactTitleDupes) {
      if (!duplicates.some(x => x.book_id === d.book_id)) {
        duplicates.push({
          book_id: d.book_id,
          title: d.title,
          author: d.author,
          status: d.status,
          confidence: 'medium',
          match_reason: 'title_exact',
        });
      }
    }

    // Tier 4: Fuzzy title match using trigram similarity (LOW confidence) - if pg_trgm available
    // For now, just do normalized title match
    const fuzzyTitleDupes = await db/*sql*/`
      SELECT b.id::text AS book_id, b.title, b.status,
             (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id LIMIT 1) AS author
      FROM books b
      WHERE LOWER(REGEXP_REPLACE(REGEXP_REPLACE(b.title, '^(the|a|an)\\s+', '', 'i'), '[^\\w\\s]', '', 'g')) = ${titleNormalized}
        AND b.id NOT IN (SELECT unnest(ARRAY[${duplicates.map(d => d.book_id).join(',')}]::uuid[]))
      LIMIT 5;
    `;
    for (const d of fuzzyTitleDupes) {
      if (!duplicates.some(x => x.book_id === d.book_id)) {
        duplicates.push({
          book_id: d.book_id,
          title: d.title,
          author: d.author,
          status: d.status,
          confidence: 'low',
          match_reason: 'title_normalized',
        });
      }
    }

    // ------------------------------------------------------------------
    // Handle duplicates
    // ------------------------------------------------------------------
    const forceCreate = url.searchParams.get("force") === "true";
    const hasHighConfidenceDupe = duplicates.some(d => d.confidence === 'high');

    if (duplicates.length > 0 && !forceCreate) {
      // Log duplicate detection event
      await db/*sql*/`
        INSERT INTO events (entity_type, entity_id, event_type, actor_id, diff_json)
        VALUES ('book', gen_random_uuid(), 'BOOK_DUPLICATE_DETECTED', ${session.sub},
                ${JSON.stringify({ attempted_title: title, attempted_author: author_name, attempted_asin: asin, duplicates })}::jsonb);
      `;

      return json({
        created: false,
        duplicates,
        message: duplicates.length === 1
          ? "A potential duplicate was found."
          : `${duplicates.length} potential duplicates found.`,
      }, 409);
    }

    // Force create requires reason for high-confidence duplicates
    if (forceCreate && hasHighConfidenceDupe && !force_reason) {
      return badRequest("force_reason is required when overriding high-confidence duplicates.");
    }

    // ------------------------------------------------------------------
    // Create the book (all-or-nothing via error handling)
    // ------------------------------------------------------------------
    try {
      // Make slug unique
      let slug = baseSlug || 'untitled';
      let suffix = 1;
      while (true) {
        const existing = await db/*sql*/`SELECT id FROM books WHERE slug = ${slug} LIMIT 1;`;
        if (existing.length === 0) break;
        slug = `${baseSlug || 'untitled'}-${++suffix}`;
        if (suffix > 100) throw new Error("Could not generate unique slug");
      }

      // Create the book
      const bookRows = await db/*sql*/`
        INSERT INTO books (title, slug, status, created_at, updated_at)
        VALUES (${title}, ${slug}, 'draft', NOW(), NOW())
        RETURNING id::text AS id;
      `;
      const bookId = bookRows[0].id;

      let authorCreated = false;
      let authorId: string | null = null;

      // Create author link if provided
      if (author_name) {
        // Find by normalized name to prevent duplicates
        const authorRows = await db/*sql*/`
          SELECT id::text AS id, name FROM authors
          WHERE LOWER(REGEXP_REPLACE(name, '[^\\w\\s]', '', 'g')) = ${authorNormalized}
          LIMIT 1;
        `;

        if (authorRows.length === 0) {
          const authorSlug = (author_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || 'author') + '-' + Date.now().toString(36).slice(-4);
          const newAuthor = await db/*sql*/`
            INSERT INTO authors (name, slug, created_at, updated_at)
            VALUES (${author_name}, ${authorSlug}, NOW(), NOW())
            RETURNING id::text AS id;
          `;
          authorId = newAuthor[0].id;
          authorCreated = true;

          // Log author creation
          await db/*sql*/`
            INSERT INTO events (entity_type, entity_id, event_type, actor_id, diff_json)
            VALUES ('author', ${authorId}::uuid, 'AUTHOR_CREATED', ${session.sub},
                    ${JSON.stringify({ name: author_name, created_for_book: bookId })}::jsonb);
          `;
        } else {
          authorId = authorRows[0].id;
        }

        await db/*sql*/`
          INSERT INTO book_authors (book_id, author_id, author_order)
          VALUES (${bookId}::uuid, ${authorId}::uuid, 1)
          ON CONFLICT DO NOTHING;
        `;
      }

      // Create identifiers if provided
      if (asin || isbn13) {
        await db/*sql*/`
          INSERT INTO book_identifiers (book_id, asin, isbn13, updated_at)
          VALUES (${bookId}::uuid, ${asin || null}, ${isbn13 || null}, NOW())
          ON CONFLICT (book_id) DO UPDATE SET
            asin = COALESCE(${asin || null}, book_identifiers.asin),
            isbn13 = COALESCE(${isbn13 || null}, book_identifiers.isbn13),
            updated_at = NOW();
        `;
      }

      // Create empty book_axes record
      await db/*sql*/`
        INSERT INTO book_axes (book_id, created_at, updated_at)
        VALUES (${bookId}::uuid, NOW(), NOW())
        ON CONFLICT DO NOTHING;
      `;

      // Create empty book_metadata record
      await db/*sql*/`
        INSERT INTO book_metadata (book_id, updated_at)
        VALUES (${bookId}::uuid, NOW())
        ON CONFLICT DO NOTHING;
      `;

      // Determine next actions
      const nextActions: string[] = ['UPLOAD_COVER', 'SET_AXES'];
      if (!author_name) nextActions.unshift('SET_AUTHOR');

      // Log event
      const eventType = forceCreate && duplicates.length > 0 ? 'BOOK_FORCE_CREATED' : 'BOOK_CREATED';
      await db/*sql*/`
        INSERT INTO events (entity_type, entity_id, event_type, actor_id, diff_json)
        VALUES ('book', ${bookId}::uuid, ${eventType}, ${session.sub},
                ${JSON.stringify({
                  title,
                  author_name,
                  asin,
                  author_created: authorCreated,
                  force_reason: force_reason || null,
                  overridden_duplicates: forceCreate ? duplicates : null,
                })}::jsonb);
      `;

      const response = {
        created: true,
        book_id: bookId,
        slug,
        author_id: authorId,
        author_created: authorCreated,
        next_actions: nextActions,
        duplicates_overridden: forceCreate ? duplicates.length : 0,
      };

      // Cache for idempotency
      if (idempotencyKey && env.RATE_LIMIT) {
        await env.RATE_LIMIT.put(`idem:book:${idempotencyKey}`, JSON.stringify(response), { expirationTtl: 86400 });
      }

      return json(response);
    } catch (e: any) {
      // Check for unique constraint violations
      if (e.message?.includes('unique') || e.message?.includes('duplicate')) {
        return json({ error: "A book with this ASIN already exists.", code: "DUPLICATE_ASIN" }, 409);
      }
      return serverError("Failed to create book", { message: String(e?.message || e) });
    }
  }

  // ------------------------------------------------------------------
  // Book Cover Upload (Versioned, Multi-Size)
  // ------------------------------------------------------------------
  // Cover sizes:
  //   original: Full resolution upload (preserved for future re-processing)
  //   xl (1600x2400): High-res display (retina, large screens)
  //   lg (800x1200): Standard web display
  //   md (400x600): Email-safe, thumbnails
  //   sm (240x360): Small thumbnails, legacy
  //
  // R2 path format: covers/{bookId}/v{version}/{size}.{ext}
  // This ensures:
  //   - Immutable originals (never overwritten)
  //   - Versioned derivatives (cache-safe)
  //   - Clean separation from legacy flat structure

  // POST /api/vault/admin/books/:id/cover - upload cover image(s)
  const coverUploadMatch = url.pathname.match(/^\/api\/vault\/admin\/books\/([0-9a-fA-F-]{36})\/cover$/);
  if (coverUploadMatch && req.method === "POST") {
    const csrfToken = req.headers.get("x-csrf-token");
    if (!csrfToken || csrfToken !== session.csrf) {
      return forbidden("CSRF token mismatch");
    }

    const bookId = coverUploadMatch[1];

    // Check book exists
    const bookRows = await db/*sql*/`SELECT id, slug FROM books WHERE id = ${bookId}::uuid;`;
    if (!bookRows.length) return notFound("Book not found");

    // Check R2 bucket is configured
    if (!env.COVERS_BUCKET) {
      return serverError("R2 bucket not configured");
    }

    // Parse multipart form data
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return badRequest("Expected multipart/form-data");
    }

    try {
      const formData = await req.formData();

      // Accept multiple sizes from frontend
      // Required: original (the source image)
      // Optional: xl (1600x2400), lg (800x1200), md (400x600), sm (240x360)
      const original = formData.get("original") as File | null;
      const xl = formData.get("xl") as File | null;       // 1600x2400 webp
      const lg = formData.get("lg") as File | null;       // 800x1200 webp
      const md = formData.get("md") as File | null;       // 400x600 jpg (email-safe)
      const sm = formData.get("sm") as File | null;       // 240x360 jpg (legacy)

      // Fallback: accept single "cover" field for backwards compatibility
      const legacyCover = formData.get("cover") as File | null;

      const hasNewFormat = original || xl || lg || md || sm;
      const hasLegacyFormat = legacyCover && !hasNewFormat;

      if (!hasNewFormat && !hasLegacyFormat) {
        return badRequest("No cover file provided. Send 'original' or legacy 'cover' field.");
      }

      // Validate file types
      const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
      const validateFile = (f: File | null, name: string, maxKb: number) => {
        if (!f) return null;
        if (!allowedTypes.includes(f.type)) {
          throw new Error(`${name}: Invalid type. Use JPEG, PNG, or WebP.`);
        }
        if (f.size > maxKb * 1024) {
          throw new Error(`${name}: Too large. Max ${maxKb}KB.`);
        }
        return f;
      };

      // Validate all provided files
      const files: Record<string, File> = {};
      try {
        if (original) files.original = validateFile(original, "original", 5000)!; // 5MB max original
        if (xl) files.xl = validateFile(xl, "xl", 800)!;
        if (lg) files.lg = validateFile(lg, "lg", 400)!;
        if (md) files.md = validateFile(md, "md", 150)!;
        if (sm) files.sm = validateFile(sm, "sm", 100)!;
        if (legacyCover) files.sm = validateFile(legacyCover, "cover", 500)!; // Legacy treated as sm
      } catch (e: any) {
        return badRequest(e.message);
      }

      // Get next version number
      const versionRows = await db/*sql*/`
        SELECT COALESCE(MAX(version), 0) AS max_version
        FROM book_assets
        WHERE book_id = ${bookId}::uuid AND asset_type = 'cover';
      `;
      const newVersion = (versionRows[0]?.max_version || 0) + 1;

      const cdnBase = env.COVERS_CDN_URL || "https://cdn.bookshook.com/covers";
      const cdnUrls: Record<string, string> = {};
      let originalUrl: string | null = null;
      let hashSha256: string | null = null;

      // Upload each provided size to versioned path
      for (const [size, file] of Object.entries(files)) {
        const ext = file.type === "image/webp" ? "webp" : file.type === "image/png" ? "png" : "jpg";
        const r2Key = `covers/${bookId}/v${newVersion}/${size}.${ext}`;
        const arrayBuffer = await file.arrayBuffer();

        // Compute hash for original
        if (size === "original") {
          const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
          hashSha256 = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
        }

        await env.COVERS_BUCKET.put(r2Key, arrayBuffer, {
          httpMetadata: {
            contentType: file.type,
            cacheControl: "public, max-age=31536000, immutable",
          },
          customMetadata: {
            bookId,
            version: String(newVersion),
            size,
            uploadedAt: new Date().toISOString(),
          },
        });

        const cdnUrl = `${cdnBase}/${bookId}/v${newVersion}/${size}.${ext}`;
        cdnUrls[size] = cdnUrl;

        if (size === "original") {
          originalUrl = cdnUrl;
        }

        console.log(`[Cover] Stored ${size} (${file.size} bytes) as ${r2Key}`);
      }

      // Determine primary cover URL (prefer lg, fall back to md, sm, or original)
      const primaryCoverUrl = cdnUrls.lg || cdnUrls.md || cdnUrls.sm || cdnUrls.original || "";

      // Update books table (legacy support - points to best available size)
      await db/*sql*/`
        UPDATE books
        SET cover_url = ${primaryCoverUrl},
            cover_source = 'r2',
            cover_updated_at = NOW(),
            updated_at = NOW()
        WHERE id = ${bookId}::uuid;
      `;

      // Insert into book_assets table (versioned system)
      await db/*sql*/`
        INSERT INTO book_assets (book_id, asset_type, version, original_url, cdn_urls_json, state, hash_sha256)
        VALUES (${bookId}::uuid, 'cover', ${newVersion}, ${originalUrl}, ${JSON.stringify(cdnUrls)}::jsonb, 'ready', ${hashSha256})
        ON CONFLICT (book_id, asset_type, version) DO UPDATE
        SET original_url = EXCLUDED.original_url,
            cdn_urls_json = EXCLUDED.cdn_urls_json,
            state = 'ready',
            hash_sha256 = EXCLUDED.hash_sha256;
      `;

      // Log event with full details
      await db/*sql*/`
        INSERT INTO events (entity_type, entity_id, event_type, actor_id, diff_json)
        VALUES ('book_assets', ${bookId}::uuid, 'COVER_UPLOADED', ${session.sub || 'system'},
                ${JSON.stringify({
                  version: newVersion,
                  sizes: Object.keys(cdnUrls),
                  urls: cdnUrls,
                  hash: hashSha256,
                })}::jsonb);
      `;

      return json({
        ok: true,
        version: newVersion,
        urls: cdnUrls,
        primary_url: primaryCoverUrl,
        hash: hashSha256,
      });
    } catch (e: any) {
      return serverError("Failed to upload cover", { message: String(e?.message || e) });
    }
  }

  // DELETE /api/vault/admin/books/:id/cover - remove cover image
  if (coverUploadMatch && req.method === "DELETE") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const bookId = coverUploadMatch[1];

    // Get current cover to delete from R2
    const bookRows = await db/*sql*/`SELECT cover_url FROM books WHERE id = ${bookId}::uuid;`;
    if (!bookRows.length) return notFound("Book not found");

    if (env.COVERS_BUCKET && bookRows[0].cover_url) {
      // Try to delete from R2 (best effort)
      try {
        const url = new URL(bookRows[0].cover_url);
        const key = url.pathname.slice(1); // Remove leading /
        await env.COVERS_BUCKET.delete(key);
      } catch {
        // Ignore R2 delete errors
      }
    }

    // Clear database
    await db/*sql*/`
      UPDATE books
      SET cover_url = NULL,
          cover_source = NULL,
          cover_updated_at = NULL,
          updated_at = NOW()
      WHERE id = ${bookId}::uuid;
    `;

    return json({ ok: true });
  }

  // ------------------------------------------------------------------
  // Cover Reprocess (for regenerating derivatives from original)
  // ------------------------------------------------------------------
  // Since Workers don't have native image processing, this endpoint:
  // 1. Returns the original URL for external download
  // 2. Marks the asset as "pending reprocess"
  // 3. Accepts new derivatives via the normal upload endpoint
  //
  // For actual reprocessing, use:
  // - Local tooling (download original, resize, upload via API)
  // - Future: WASM image pipeline in Worker

  // POST /api/vault/admin/books/:id/cover/reprocess
  const reprocessMatch = url.pathname.match(/^\/api\/vault\/admin\/books\/([0-9a-fA-F-]{36})\/cover\/reprocess$/);
  if (reprocessMatch && req.method === "POST") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const bookId = reprocessMatch[1];

    const ReprocessSchema = z.object({
      version: z.number().int().positive().optional(),  // Which version to reprocess (defaults to latest)
    });

    let body: unknown;
    try { body = await req.json(); } catch { body = {}; }
    const parsed = ReprocessSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    // Get the specified version or latest
    const versionFilter = parsed.data.version
      ? await db/*sql*/`SELECT * FROM book_assets WHERE book_id = ${bookId}::uuid AND asset_type = 'cover' AND version = ${parsed.data.version};`
      : await db/*sql*/`SELECT * FROM book_assets WHERE book_id = ${bookId}::uuid AND asset_type = 'cover' ORDER BY version DESC LIMIT 1;`;

    if (!versionFilter.length) {
      return notFound("No cover asset found for this book");
    }

    const asset = versionFilter[0];

    if (!asset.original_url) {
      return badRequest("No original file stored for this version - cannot reprocess");
    }

    // Mark as pending reprocess
    await db/*sql*/`
      UPDATE book_assets
      SET processing_status = 'pending_reprocess',
          reprocess_requested_at = NOW(),
          reprocess_requested_by = ${session.sub},
          reprocess_source_version = ${asset.version}
      WHERE id = ${asset.id}::uuid;
    `;

    // Log event (entity_id must match entity_type - use asset.id for book_assets)
    await db/*sql*/`
      INSERT INTO events (entity_type, entity_id, event_type, actor_id, diff_json)
      VALUES ('book_assets', ${asset.id}::uuid, 'COVER_REPROCESS_REQUESTED', ${session.sub},
              ${JSON.stringify({ book_id: bookId, version: asset.version, original_url: asset.original_url })}::jsonb);
    `;

    return json({
      ok: true,
      message: "Reprocess requested. Download original, generate derivatives, and upload via POST /cover",
      version: asset.version,
      original_url: asset.original_url,
      cdn_urls: asset.cdn_urls_json,
      instructions: {
        step1: "Download the original file from original_url",
        step2: "Generate derivatives: xl (1600x2400 webp), lg (800x1200 webp), md (400x600 jpg), sm (240x360 jpg)",
        step3: "Upload via POST /api/vault/admin/books/:id/cover with multipart form data",
      },
    });
  }

  // GET /api/vault/admin/books/:id/cover/status - Check cover processing status
  const coverStatusMatch = url.pathname.match(/^\/api\/vault\/admin\/books\/([0-9a-fA-F-]{36})\/cover\/status$/);
  if (coverStatusMatch && req.method === "GET") {
    const bookId = coverStatusMatch[1];

    const assets = await db/*sql*/`
      SELECT version, original_url, cdn_urls_json, state, processing_status, hash_sha256,
             reprocess_requested_at, reprocess_requested_by, reprocess_source_version
      FROM book_assets
      WHERE book_id = ${bookId}::uuid AND asset_type = 'cover'
      ORDER BY version DESC;
    `;

    if (!assets.length) {
      return json({ has_cover: false, versions: [] });
    }

    return json({
      has_cover: true,
      current_version: assets[0].version,
      current_state: assets[0].state,
      processing_status: assets[0].processing_status,
      versions: assets.map((a: any) => ({
        version: a.version,
        state: a.state,
        processing_status: a.processing_status,
        has_original: !!a.original_url,
        sizes: a.cdn_urls_json ? Object.keys(a.cdn_urls_json) : [],
        hash: a.hash_sha256,
        reprocess_requested: a.reprocess_requested_at,
      })),
    });
  }

  // ------------------------------------------------------------------
  // Book Intakes Review (full book submissions from authors)
  // ------------------------------------------------------------------

  // GET /api/vault/admin/book-intakes?status=pending
  if (req.method === "GET" && url.pathname === "/api/vault/admin/book-intakes") {
    const status = url.searchParams.get("status") ?? "pending";
    const rows = await db/*sql*/`
      SELECT
        bi.id::text AS id,
        bi.asin,
        bi.intake_json->>'title' AS title,
        bi.intake_json->>'series_name' AS series_name,
        bi.intake_json->>'series_number' AS series_number,
        bi.status,
        bi.admin_notes,
        bi.created_at,
        bi.updated_at,
        bi.created_book_id::text AS created_book_id,
        apa.email AS author_email,
        apa.display_name AS author_display_name,
        a.name AS author_name
      FROM author_book_intakes bi
      JOIN author_portal_accounts apa ON apa.id = bi.author_account_id
      JOIN authors a ON a.id = apa.author_id
      WHERE bi.status = ${status}
      ORDER BY bi.created_at ASC
      LIMIT 200;
    `;
    return json({ items: rows });
  }

  // GET /api/vault/admin/book-intakes/:id - full detail view
  const intakeDetailMatch = url.pathname.match(/^\/api\/vault\/admin\/book-intakes\/([0-9a-fA-F-]{36})$/);
  if (intakeDetailMatch && req.method === "GET") {
    const intakeId = intakeDetailMatch[1];
    const rows = await db/*sql*/`
      SELECT
        bi.*,
        apa.email AS author_email,
        apa.display_name AS author_display_name,
        a.name AS author_name,
        a.id::text AS author_id
      FROM author_book_intakes bi
      JOIN author_portal_accounts apa ON apa.id = bi.author_account_id
      JOIN authors a ON a.id = apa.author_id
      WHERE bi.id = ${intakeId}::uuid;
    `;
    if (!rows.length) return notFound("Book intake not found");

    const intake = rows[0];

    // Resolve tag IDs to names for easier review
    const intakeJson = intake.intake_json as any;
    const allTagIds = new Set<string>();

    // Collect all tag IDs from the intake
    if (intakeJson.axes) {
      Object.values(intakeJson.axes).forEach((id: any) => id && allTagIds.add(id));
    }
    (intakeJson.content_warnings || []).forEach((t: any) => allTagIds.add(t.tag_id));
    (intakeJson.tropes || []).forEach((t: any) => allTagIds.add(t.tag_id));
    (intakeJson.hero_archetypes || []).forEach((id: string) => allTagIds.add(id));
    (intakeJson.heroine_archetypes || []).forEach((id: string) => allTagIds.add(id));
    (intakeJson.representation || []).forEach((t: any) => allTagIds.add(t.tag_id));
    (intakeJson.kink_bundles || []).forEach((id: string) => allTagIds.add(id));
    (intakeJson.kink_details || []).forEach((t: any) => allTagIds.add(t.tag_id));

    const tagIdArray = [...allTagIds];
    const tags = tagIdArray.length > 0
      ? await db/*sql*/`SELECT id::text AS id, category, slug, name FROM tags WHERE id = ANY(${tagIdArray}::uuid[]);`
      : [];

    const tagMap = Object.fromEntries(tags.map((t: any) => [t.id, t]));

    // Check if book already exists by ASIN
    const existingBook = await db/*sql*/`
      SELECT id::text AS id, title, slug FROM books WHERE asin = ${intake.asin} LIMIT 1;
    `;

    return json({
      intake: {
        ...intake,
        id: intake.id.toString(),
        author_account_id: intake.author_account_id.toString(),
        created_book_id: intake.created_book_id?.toString() || null,
      },
      tags: tagMap,
      existing_book: existingBook[0] || null,
    });
  }

  const DecideIntakeSchema = z.object({
    action: z.enum(["approve", "reject"]),
    admin_notes: z.string().max(1000).optional(),
    // For approve: optionally override some book details
    book_overrides: z.object({
      title: z.string().min(1).max(300).optional(),
      slug: z.string().min(1).max(300).optional(),
    }).optional(),
  });

  // POST /api/vault/admin/book-intakes/:id/decide
  const intakeDecideMatch = url.pathname.match(/^\/api\/vault\/admin\/book-intakes\/([0-9a-fA-F-]{36})\/decide$/);
  if (intakeDecideMatch && req.method === "POST") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = DecideIntakeSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    const intakeId = intakeDecideMatch[1];
    const rows = await db/*sql*/`SELECT * FROM author_book_intakes WHERE id = ${intakeId}::uuid;`;
    if (!rows.length) return notFound("Book intake not found");
    const intake = rows[0];

    if (intake.status !== "pending") {
      return badRequest(`Intake already ${intake.status}`);
    }

    if (parsed.data.action === "reject") {
      await db/*sql*/`
        UPDATE author_book_intakes
        SET status = 'rejected',
            admin_notes = ${parsed.data.admin_notes ?? "Rejected"},
            updated_at = NOW()
        WHERE id = ${intakeId}::uuid;
      `;
      return json({ ok: true, status: "rejected" });
    }

    // APPROVE: Create book and apply all tags
    try {
      const intakeJson = intake.intake_json as any;
      const bookTitle = parsed.data.book_overrides?.title || intakeJson.title;
      const bookSlug = parsed.data.book_overrides?.slug || slugify(bookTitle);

      // Check if book already exists by ASIN
      const existingBook = await db/*sql*/`
        SELECT id FROM books WHERE asin = ${intake.asin} LIMIT 1;
      `;

      let bookId: string;

      if (existingBook.length) {
        // Book exists, just use it
        bookId = existingBook[0].id;
      } else {
        // Create new book
        const newBook = await db/*sql*/`
          INSERT INTO books (title, slug, asin, series_name, series_number, published_year)
          VALUES (
            ${bookTitle},
            ${bookSlug},
            ${intake.asin},
            ${intakeJson.series_name || null},
            ${intakeJson.series_number || null},
            ${intakeJson.publication_date ? new Date(intakeJson.publication_date).getFullYear() : null}
          )
          ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title
          RETURNING id;
        `;
        bookId = newBook[0].id;

        // Link author to book
        const authorAccount = await db/*sql*/`
          SELECT author_id FROM author_portal_accounts WHERE id = ${intake.author_account_id}::uuid;
        `;
        if (authorAccount.length) {
          await db/*sql*/`
            INSERT INTO book_authors (book_id, author_id, author_order)
            VALUES (${bookId}::uuid, ${authorAccount[0].author_id}::uuid, 1)
            ON CONFLICT (book_id, author_id) DO NOTHING;
          `;
        }
      }

      // Collect all tag IDs to apply
      const tagIdsToApply = new Set<string>();

      // Required axes
      if (intakeJson.axes) {
        Object.values(intakeJson.axes).forEach((id: any) => id && tagIdsToApply.add(id));
      }

      // Optional tag arrays
      (intakeJson.content_warnings || []).forEach((t: any) => tagIdsToApply.add(t.tag_id));
      (intakeJson.tropes || []).forEach((t: any) => tagIdsToApply.add(t.tag_id));
      (intakeJson.hero_archetypes || []).forEach((id: string) => tagIdsToApply.add(id));
      (intakeJson.heroine_archetypes || []).forEach((id: string) => tagIdsToApply.add(id));
      (intakeJson.representation || []).forEach((t: any) => tagIdsToApply.add(t.tag_id));
      (intakeJson.kink_bundles || []).forEach((id: string) => tagIdsToApply.add(id));
      (intakeJson.kink_details || []).forEach((t: any) => tagIdsToApply.add(t.tag_id));

      // Apply all tags to book
      for (const tagId of tagIdsToApply) {
        await db/*sql*/`
          INSERT INTO book_tags (book_id, tag_id)
          VALUES (${bookId}::uuid, ${tagId}::uuid)
          ON CONFLICT (book_id, tag_id) DO NOTHING;
        `;
      }

      // Update intake as approved
      await db/*sql*/`
        UPDATE author_book_intakes
        SET status = 'approved',
            admin_notes = ${parsed.data.admin_notes ?? null},
            created_book_id = ${bookId}::uuid,
            updated_at = NOW()
        WHERE id = ${intakeId}::uuid;
      `;

      return json({ ok: true, status: "approved", book_id: bookId });
    } catch (e: any) {
      return serverError("Failed to approve book intake", { message: String(e?.message || e) });
    }
  }

  // ------------------------------------------------------------------
  // Curator Workbench: Book Editing & Tagging
  // ------------------------------------------------------------------

  // GET /api/vault/admin/tags/full - All tags with descriptions for typeahead
  if (req.method === "GET" && url.pathname === "/api/vault/admin/tags/full") {
    const rows = await db/*sql*/`
      SELECT
        t.id::text AS id,
        t.category,
        t.slug,
        t.name,
        t.description,
        t.sensitive_flag AS "sensitiveFlag",
        t.display_order AS "displayOrder",
        tc.single_select AS "singleSelect",
        CASE
          WHEN t.category = 'trope' THEN 8
          WHEN t.category = 'plot_engine' THEN 2
          WHEN t.category = 'setting_wrapper' THEN 2
          WHEN t.category = 'seasonal_wrapper' THEN 1
          ELSE NULL
        END AS "cap"
      FROM tags t
      JOIN tag_categories tc ON tc.key = t.category
      ORDER BY tc.display_order ASC, t.display_order ASC, t.name ASC;
    `;

    // Group by category for easier UI consumption
    const byCategory: Record<string, any[]> = {};
    for (const tag of rows) {
      if (!byCategory[tag.category]) {
        byCategory[tag.category] = [];
      }
      byCategory[tag.category].push(tag);
    }

    // Get category metadata
    const categories = await db/*sql*/`
      SELECT key, label, single_select AS "singleSelect", display_order AS "displayOrder"
      FROM tag_categories
      ORDER BY display_order ASC;
    `;

    return json({ tags: rows, byCategory, categories });
  }

  // GET /api/vault/admin/books/:id - Full workbench payload
  const bookDetailMatch = url.pathname.match(/^\/api\/vault\/admin\/books\/([0-9a-fA-F-]{36})$/);
  if (bookDetailMatch && req.method === "GET") {
    const bookId = bookDetailMatch[1];

    // Core book data
    const bookRows = await db/*sql*/`
      SELECT
        b.id::text AS id,
        b.title,
        b.slug,
        b.status,
        b.created_at AS "createdAt",
        b.updated_at AS "updatedAt"
      FROM books b
      WHERE b.id = ${bookId}::uuid;
    `;
    if (!bookRows.length) return notFound("Book not found");
    const book = bookRows[0];

    // Metadata
    const metaRows = await db/*sql*/`
      SELECT blurb_short AS "blurbShort", blurb_long AS "blurbLong", pub_year AS "pubYear",
             page_count AS "pageCount", ku_status AS "kuStatus", heat_notes AS "heatNotes"
      FROM book_metadata WHERE book_id = ${bookId}::uuid;
    `;
    const metadata = metaRows[0] || {};

    // Identifiers
    const idRows = await db/*sql*/`
      SELECT asin, isbn13, amazon_url AS "amazonUrl", goodreads_url AS "goodreadsUrl"
      FROM book_identifiers WHERE book_id = ${bookId}::uuid;
    `;
    const identifiers = idRows[0] || {};

    // Assets (cover)
    const assetRows = await db/*sql*/`
      SELECT id::text, version, original_url AS "originalUrl", crop_json AS "cropJson",
             cdn_urls_json AS "cdnUrls", state, hash_sha256 AS "hash"
      FROM book_assets WHERE book_id = ${bookId}::uuid AND asset_type = 'cover'
      ORDER BY version DESC LIMIT 1;
    `;
    const assets = { cover: assetRows[0] || null };

    // Axes (from book_axes table)
    const axesRows = await db/*sql*/`
      SELECT
        world_framework_tag_id::text AS "worldFramework",
        pairing_tag_id::text AS "pairing",
        heat_level_tag_id::text AS "heatLevel",
        series_status_tag_id::text AS "seriesStatus",
        consent_mode_tag_id::text AS "consentMode"
      FROM book_axes WHERE book_id = ${bookId}::uuid;
    `;
    const axes = axesRows[0] || {};

    // Tags (non-axis tags from book_tags)
    const tagRows = await db/*sql*/`
      SELECT
        t.id::text AS id,
        t.category,
        t.slug,
        t.name,
        t.description,
        t.sensitive_flag AS "sensitiveFlag",
        t.requires_evidence AS "requiresEvidence",
        tc.single_select AS "singleSelect"
      FROM book_tags bt
      JOIN tags t ON t.id = bt.tag_id
      JOIN tag_categories tc ON tc.key = t.category
      WHERE bt.book_id = ${bookId}::uuid
        AND t.category NOT IN ('world_framework', 'pairing', 'heat_level', 'series_status', 'consent_mode')
      ORDER BY tc.display_order ASC, t.display_order ASC;
    `;

    // Group tags by category
    const tags: Record<string, any[]> = {};
    for (const t of tagRows) {
      if (!tags[t.category]) tags[t.category] = [];
      tags[t.category].push(t);
    }

    // Evidence
    const evidenceRows = await db/*sql*/`
      SELECT
        e.id::text AS id,
        e.evidence_type AS "type",
        e.quote_text AS "quoteText",
        e.external_url AS "externalUrl",
        e.location_type AS "locationType",
        e.location_value AS "locationValue",
        e.evidence_note AS "note",
        e.created_at AS "createdAt",
        COALESCE(
          (SELECT json_agg(json_build_object('targetType', el.target_type, 'targetId', el.target_id::text))
           FROM evidence_links el WHERE el.evidence_id = e.id),
          '[]'::json
        ) AS links
      FROM evidence e
      WHERE e.book_id = ${bookId}::uuid
      ORDER BY e.created_at DESC;
    `;

    // Standout quotes
    const quotesRows = await db/*sql*/`
      SELECT id::text, quote_label AS "label", quote_text AS "quoteText",
             location_type AS "locationType", location_value AS "locationValue",
             use_in_drop_email AS "useInDropEmail"
      FROM standout_quotes WHERE book_id = ${bookId}::uuid;
    `;

    // Authors
    const authors = await db/*sql*/`
      SELECT a.id::text AS id, a.name, a.slug
      FROM authors a
      JOIN book_authors ba ON ba.author_id = a.id
      WHERE ba.book_id = ${bookId}::uuid
      ORDER BY ba.author_order ASC;
    `;

    // Validation
    const validation = await computeValidation(db, bookId, axes, tags, evidenceRows, assets);

    return json({
      book,
      metadata,
      identifiers,
      assets,
      axes,
      tags,
      evidence: evidenceRows,
      standoutQuotes: quotesRows,
      authors,
      validation,
    });
  }

  // PUT /api/vault/admin/books/:id - Update book metadata
  if (bookDetailMatch && req.method === "PUT") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const bookId = bookDetailMatch[1];

    const UpdateBookSchema = z.object({
      title: z.string().min(1).max(300).optional(),
      asin: z.string().max(20).nullable().optional(),
      isbn: z.string().max(20).nullable().optional(),
      amazonUrl: z.string().url().nullable().optional(),
      goodreadsUrl: z.string().url().nullable().optional(),
      seriesName: z.string().max(200).nullable().optional(),
      seriesPosition: z.string().max(50).nullable().optional(),
      pageCount: z.number().int().positive().nullable().optional(),
      publishedYear: z.number().int().min(1800).max(2100).nullable().optional(),
      kindleUnlimited: z.boolean().nullable().optional(),
      isPublished: z.boolean().optional(),
    });

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = UpdateBookSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    // Check book exists
    const existing = await db/*sql*/`SELECT id FROM books WHERE id = ${bookId}::uuid;`;
    if (!existing.length) return notFound("Book not found");

    try {
      const d = parsed.data;
      if (d.title !== undefined) {
        await db/*sql*/`UPDATE books SET title = ${d.title}, updated_at = NOW() WHERE id = ${bookId}::uuid;`;
      }
      if (d.asin !== undefined) {
        await db/*sql*/`UPDATE books SET asin = ${d.asin}, updated_at = NOW() WHERE id = ${bookId}::uuid;`;
      }
      if (d.isbn !== undefined) {
        await db/*sql*/`UPDATE books SET isbn = ${d.isbn}, updated_at = NOW() WHERE id = ${bookId}::uuid;`;
      }
      if (d.amazonUrl !== undefined) {
        await db/*sql*/`UPDATE books SET amazon_url = ${d.amazonUrl}, updated_at = NOW() WHERE id = ${bookId}::uuid;`;
      }
      if (d.goodreadsUrl !== undefined) {
        await db/*sql*/`UPDATE books SET goodreads_url = ${d.goodreadsUrl}, updated_at = NOW() WHERE id = ${bookId}::uuid;`;
      }
      if (d.seriesName !== undefined) {
        await db/*sql*/`UPDATE books SET series_name = ${d.seriesName}, updated_at = NOW() WHERE id = ${bookId}::uuid;`;
      }
      if (d.seriesPosition !== undefined) {
        await db/*sql*/`UPDATE books SET series_position = ${d.seriesPosition}, updated_at = NOW() WHERE id = ${bookId}::uuid;`;
      }
      if (d.pageCount !== undefined) {
        await db/*sql*/`UPDATE books SET page_count = ${d.pageCount}, updated_at = NOW() WHERE id = ${bookId}::uuid;`;
      }
      if (d.publishedYear !== undefined) {
        await db/*sql*/`UPDATE books SET published_year = ${d.publishedYear}, updated_at = NOW() WHERE id = ${bookId}::uuid;`;
      }
      if (d.kindleUnlimited !== undefined) {
        await db/*sql*/`UPDATE books SET kindle_unlimited = ${d.kindleUnlimited}, updated_at = NOW() WHERE id = ${bookId}::uuid;`;
      }
      if (d.isPublished !== undefined) {
        await db/*sql*/`UPDATE books SET is_published = ${d.isPublished}, updated_at = NOW() WHERE id = ${bookId}::uuid;`;
      }

      return json({ ok: true });
    } catch (e: any) {
      return serverError("Failed to update book", { message: String(e?.message || e) });
    }
  }

  // POST /api/vault/admin/books/:id/tags - Add tag to book with cap enforcement
  const addTagMatch = url.pathname.match(/^\/api\/vault\/admin\/books\/([0-9a-fA-F-]{36})\/tags$/);
  if (addTagMatch && req.method === "POST") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const bookId = addTagMatch[1];

    const AddTagSchema = z.object({
      tag_id: z.string().uuid(),
    });

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = AddTagSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    // Get tag info
    const tagRows = await db/*sql*/`
      SELECT t.id, t.category, t.name, tc.single_select
      FROM tags t
      JOIN tag_categories tc ON tc.key = t.category
      WHERE t.id = ${parsed.data.tag_id}::uuid;
    `;
    if (!tagRows.length) return notFound("Tag not found");
    const tag = tagRows[0];

    // Define caps
    const CAPS: Record<string, number> = {
      trope: 8,
      plot_engine: 2,
      setting_wrapper: 2,
      seasonal_wrapper: 1,
    };

    // Check cap for this category
    const cap = CAPS[tag.category];
    if (cap) {
      const countRows = await db/*sql*/`
        SELECT COUNT(*)::int AS count
        FROM book_tags bt
        JOIN tags t ON t.id = bt.tag_id
        WHERE bt.book_id = ${bookId}::uuid AND t.category = ${tag.category};
      `;
      if (countRows[0].count >= cap) {
        return json({ error: "cap_exceeded", category: tag.category, cap }, { status: 400 });
      }
    }

    // For single-select categories, remove existing tag first
    if (tag.single_select) {
      await db/*sql*/`
        DELETE FROM book_tags
        WHERE book_id = ${bookId}::uuid
        AND tag_id IN (SELECT id FROM tags WHERE category = ${tag.category});
      `;
    }

    // Add the tag
    try {
      await db/*sql*/`
        INSERT INTO book_tags (book_id, tag_id)
        VALUES (${bookId}::uuid, ${parsed.data.tag_id}::uuid)
        ON CONFLICT (book_id, tag_id) DO NOTHING;
      `;
      return json({ ok: true, tag: { id: tag.id, category: tag.category, name: tag.name } });
    } catch (e: any) {
      return serverError("Failed to add tag", { message: String(e?.message || e) });
    }
  }

  // DELETE /api/vault/admin/books/:id/tags/:tagId - Remove tag from book
  const removeTagMatch = url.pathname.match(/^\/api\/vault\/admin\/books\/([0-9a-fA-F-]{36})\/tags\/([0-9a-fA-F-]{36})$/);
  if (removeTagMatch && req.method === "DELETE") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const bookId = removeTagMatch[1];
    const tagId = removeTagMatch[2];

    try {
      await db/*sql*/`
        DELETE FROM book_tags
        WHERE book_id = ${bookId}::uuid AND tag_id = ${tagId}::uuid;
      `;

      // Log event
      await db/*sql*/`
        INSERT INTO events (entity_type, entity_id, event_type, actor_id, diff_json)
        VALUES ('book_tag', ${bookId}::uuid, 'TAG_REMOVED', ${session.sub}, ${JSON.stringify({ tagId })});
      `;

      return json({ ok: true });
    } catch (e: any) {
      return serverError("Failed to remove tag", { message: String(e?.message || e) });
    }
  }

  // ------------------------------------------------------------------
  // Standalone Validation Endpoint
  // ------------------------------------------------------------------
  // Returns live validation status without modifying anything.
  // Use for real-time validation in the workbench UI.

  // GET /api/vault/admin/books/:id/validation
  const validationMatch = url.pathname.match(/^\/api\/vault\/admin\/books\/([0-9a-fA-F-]{36})\/validation$/);
  if (validationMatch && req.method === "GET") {
    const bookId = validationMatch[1];

    // Check book exists
    const bookRows = await db/*sql*/`SELECT id FROM books WHERE id = ${bookId}::uuid;`;
    if (!bookRows.length) return notFound("Book not found");

    // Load data for validation
    const axesRows = await db/*sql*/`
      SELECT
        world_framework_tag_id::text AS "worldFramework",
        pairing_tag_id::text AS "pairing",
        heat_level_tag_id::text AS "heatLevel",
        series_status_tag_id::text AS "seriesStatus",
        consent_mode_tag_id::text AS "consentMode"
      FROM book_axes WHERE book_id = ${bookId}::uuid;
    `;
    const axes = axesRows[0] || {};

    const tagRows = await db/*sql*/`
      SELECT t.id::text AS id, t.category, t.slug, t.name, t.requires_evidence AS "requiresEvidence"
      FROM book_tags bt
      JOIN tags t ON t.id = bt.tag_id
      WHERE bt.book_id = ${bookId}::uuid;
    `;
    const tags: Record<string, any[]> = {};
    for (const t of tagRows) {
      if (!tags[t.category]) tags[t.category] = [];
      tags[t.category].push(t);
    }

    const evidenceRows = await db/*sql*/`
      SELECT e.id::text, el.target_type AS "targetType", el.target_id::text AS "targetId"
      FROM evidence e
      JOIN evidence_links el ON el.evidence_id = e.id
      WHERE e.book_id = ${bookId}::uuid;
    `;

    const assetRows = await db/*sql*/`
      SELECT state FROM book_assets
      WHERE book_id = ${bookId}::uuid AND asset_type = 'cover' AND state = 'ready'
      ORDER BY version DESC LIMIT 1;
    `;
    const assets = { cover: assetRows[0] || null };

    // Run validation
    const validation = await computeValidation(db, bookId, axes, tags, evidenceRows, assets);

    // Build response with explicit blocking/warning categories
    const blocking = validation.gates
      .filter((g: any) => !g.ok)
      .map((g: any) => ({
        type: g.id === 'REQ_AXES' ? 'missing_axis' : g.id === 'REQ_COVER' ? 'missing_cover' : g.id === 'REQ_EVIDENCE' ? 'missing_evidence' : g.id,
        details: g.missing || [],
      }));

    const warnings = validation.contradictions
      .filter((c: any) => c.severity === 'soft')
      .map((c: any) => ({
        type: 'soft_contradiction',
        ruleId: c.ruleId,
        message: c.message,
      }));

    const hardErrors = validation.contradictions
      .filter((c: any) => c.severity === 'hard')
      .map((c: any) => ({
        type: 'hard_contradiction',
        ruleId: c.ruleId,
        message: c.message,
      }));

    // Combine hard contradictions with blocking gates
    blocking.push(...hardErrors);

    // Determine queue membership
    const queues: string[] = [];
    if (validation.gates.some((g: any) => !g.ok && (g.id === 'REQ_AXES' || g.id === 'REQ_COVER'))) {
      queues.push('unfinished');
    }
    if (validation.gates.some((g: any) => !g.ok && g.id === 'REQ_EVIDENCE')) {
      queues.push('needs_evidence');
    }
    if (hardErrors.length > 0) {
      queues.push('contradiction');
    }

    return json({
      valid: blocking.length === 0,
      blocking,
      warnings,
      queues,
      // Include raw validation for debugging
      _raw: validation,
    });
  }

  // ------------------------------------------------------------------
  // Axes Management
  // ------------------------------------------------------------------

  // PUT /api/vault/admin/books/:id/axes - Update required axes
  const axesMatch = url.pathname.match(/^\/api\/vault\/admin\/books\/([0-9a-fA-F-]{36})\/axes$/);
  if (axesMatch && req.method === "PUT") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const bookId = axesMatch[1];

    const AxesSchema = z.object({
      worldFramework: z.string().uuid().nullable().optional(),
      pairing: z.string().uuid().nullable().optional(),
      heatLevel: z.string().uuid().nullable().optional(),
      seriesStatus: z.string().uuid().nullable().optional(),
      consentMode: z.string().uuid().nullable().optional(),
    });

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = AxesSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    try {
      // Upsert book_axes
      await db/*sql*/`
        INSERT INTO book_axes (book_id, world_framework_tag_id, pairing_tag_id, heat_level_tag_id, series_status_tag_id, consent_mode_tag_id, axes_set_at, axes_set_by)
        VALUES (
          ${bookId}::uuid,
          ${parsed.data.worldFramework || null}::uuid,
          ${parsed.data.pairing || null}::uuid,
          ${parsed.data.heatLevel || null}::uuid,
          ${parsed.data.seriesStatus || null}::uuid,
          ${parsed.data.consentMode || null}::uuid,
          NOW(),
          ${session.sub}
        )
        ON CONFLICT (book_id) DO UPDATE SET
          world_framework_tag_id = COALESCE(${parsed.data.worldFramework}::uuid, book_axes.world_framework_tag_id),
          pairing_tag_id = COALESCE(${parsed.data.pairing}::uuid, book_axes.pairing_tag_id),
          heat_level_tag_id = COALESCE(${parsed.data.heatLevel}::uuid, book_axes.heat_level_tag_id),
          series_status_tag_id = COALESCE(${parsed.data.seriesStatus}::uuid, book_axes.series_status_tag_id),
          consent_mode_tag_id = COALESCE(${parsed.data.consentMode}::uuid, book_axes.consent_mode_tag_id),
          axes_set_at = NOW(),
          axes_set_by = ${session.sub},
          updated_at = NOW();
      `;

      // Log event
      await db/*sql*/`
        INSERT INTO events (entity_type, entity_id, event_type, actor_id, diff_json)
        VALUES ('book_axes', ${bookId}::uuid, 'AXES_UPDATED', ${session.sub}, ${JSON.stringify(parsed.data)});
      `;

      return json({ ok: true });
    } catch (e: any) {
      return serverError("Failed to update axes", { message: String(e?.message || e) });
    }
  }

  // ------------------------------------------------------------------
  // Evidence System
  // ------------------------------------------------------------------

  // POST /api/vault/admin/books/:id/evidence - Create evidence
  const evidenceMatch = url.pathname.match(/^\/api\/vault\/admin\/books\/([0-9a-fA-F-]{36})\/evidence$/);
  if (evidenceMatch && req.method === "POST") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const bookId = evidenceMatch[1];

    const EvidenceSchema = z.object({
      type: z.enum(['quote', 'scene_note', 'external_link']),
      quoteText: z.string().max(2000).optional(),
      externalUrl: z.string().url().optional(),
      locationType: z.enum(['chapter_pct', 'page', 'kindle_loc']).optional(),
      locationValue: z.string().max(50).optional(),
      note: z.string().max(500).optional(),
      links: z.array(z.object({
        targetType: z.enum(['tag', 'axis']),
        targetId: z.string().uuid(),
      })).optional(),
    });

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = EvidenceSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    try {
      const rows = await db/*sql*/`
        INSERT INTO evidence (book_id, evidence_type, quote_text, external_url, location_type, location_value, evidence_note, created_by)
        VALUES (
          ${bookId}::uuid,
          ${parsed.data.type},
          ${parsed.data.quoteText || null},
          ${parsed.data.externalUrl || null},
          ${parsed.data.locationType || null},
          ${parsed.data.locationValue || null},
          ${parsed.data.note || null},
          ${session.sub}
        )
        RETURNING id::text;
      `;
      const evidenceId = rows[0].id;

      // Create links
      if (parsed.data.links?.length) {
        for (const link of parsed.data.links) {
          await db/*sql*/`
            INSERT INTO evidence_links (evidence_id, target_type, target_id)
            VALUES (${evidenceId}::uuid, ${link.targetType}, ${link.targetId}::uuid)
            ON CONFLICT DO NOTHING;
          `;
        }
      }

      // Log event
      await db/*sql*/`
        INSERT INTO events (entity_type, entity_id, event_type, actor_id)
        VALUES ('evidence', ${evidenceId}::uuid, 'EVIDENCE_CREATED', ${session.sub});
      `;

      return json({ ok: true, id: evidenceId });
    } catch (e: any) {
      return serverError("Failed to create evidence", { message: String(e?.message || e) });
    }
  }

  // DELETE /api/vault/admin/evidence/:id - Delete evidence
  const deleteEvidenceMatch = url.pathname.match(/^\/api\/vault\/admin\/evidence\/([0-9a-fA-F-]{36})$/);
  if (deleteEvidenceMatch && req.method === "DELETE") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const evidenceId = deleteEvidenceMatch[1];

    try {
      await db/*sql*/`DELETE FROM evidence WHERE id = ${evidenceId}::uuid;`;

      await db/*sql*/`
        INSERT INTO events (entity_type, entity_id, event_type, actor_id)
        VALUES ('evidence', ${evidenceId}::uuid, 'EVIDENCE_DELETED', ${session.sub});
      `;

      return json({ ok: true });
    } catch (e: any) {
      return serverError("Failed to delete evidence", { message: String(e?.message || e) });
    }
  }

  // POST /api/vault/admin/evidence/:id/link - Link evidence to tag/axis
  const linkEvidenceMatch = url.pathname.match(/^\/api\/vault\/admin\/evidence\/([0-9a-fA-F-]{36})\/link$/);
  if (linkEvidenceMatch && req.method === "POST") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const evidenceId = linkEvidenceMatch[1];

    const LinkSchema = z.object({
      targetType: z.enum(['tag', 'axis']),
      targetId: z.string().uuid(),
    });

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = LinkSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    try {
      await db/*sql*/`
        INSERT INTO evidence_links (evidence_id, target_type, target_id)
        VALUES (${evidenceId}::uuid, ${parsed.data.targetType}, ${parsed.data.targetId}::uuid)
        ON CONFLICT DO NOTHING;
      `;
      return json({ ok: true });
    } catch (e: any) {
      return serverError("Failed to link evidence", { message: String(e?.message || e) });
    }
  }

  // ------------------------------------------------------------------
  // Standout Quotes
  // ------------------------------------------------------------------

  // POST /api/vault/admin/books/:id/standout-quotes
  const standoutMatch = url.pathname.match(/^\/api\/vault\/admin\/books\/([0-9a-fA-F-]{36})\/standout-quotes$/);
  if (standoutMatch && req.method === "POST") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const bookId = standoutMatch[1];

    // Check limit (max 2)
    const countRows = await db/*sql*/`SELECT COUNT(*)::int AS count FROM standout_quotes WHERE book_id = ${bookId}::uuid;`;
    if (countRows[0].count >= 2) {
      return badRequest("Maximum 2 standout quotes per book");
    }

    const QuoteSchema = z.object({
      label: z.enum(['funny', 'sad', 'romantic', 'feral', 'other']),
      quoteText: z.string().min(1).max(1000),
      locationType: z.enum(['chapter_pct', 'page', 'kindle_loc']).optional(),
      locationValue: z.string().max(50).optional(),
      useInDropEmail: z.boolean().optional(),
    });

    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = QuoteSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    try {
      const rows = await db/*sql*/`
        INSERT INTO standout_quotes (book_id, quote_label, quote_text, location_type, location_value, use_in_drop_email, created_by)
        VALUES (
          ${bookId}::uuid,
          ${parsed.data.label},
          ${parsed.data.quoteText},
          ${parsed.data.locationType || null},
          ${parsed.data.locationValue || null},
          ${parsed.data.useInDropEmail || false},
          ${session.sub}
        )
        RETURNING id::text;
      `;
      return json({ ok: true, id: rows[0].id });
    } catch (e: any) {
      return serverError("Failed to create quote", { message: String(e?.message || e) });
    }
  }

  // DELETE /api/vault/admin/standout-quotes/:id
  const deleteQuoteMatch = url.pathname.match(/^\/api\/vault\/admin\/standout-quotes\/([0-9a-fA-F-]{36})$/);
  if (deleteQuoteMatch && req.method === "DELETE") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const quoteId = deleteQuoteMatch[1];

    try {
      await db/*sql*/`DELETE FROM standout_quotes WHERE id = ${quoteId}::uuid;`;
      return json({ ok: true });
    } catch (e: any) {
      return serverError("Failed to delete quote", { message: String(e?.message || e) });
    }
  }

  // ------------------------------------------------------------------
  // Queues
  // ------------------------------------------------------------------

  // GET /api/vault/admin/queues/unfinished
  if (req.method === "GET" && url.pathname === "/api/vault/admin/queues/unfinished") {
    const rows = await db/*sql*/`
      SELECT
        b.id::text AS id,
        b.title,
        b.status,
        ba.world_framework_tag_id IS NULL AS "missingWorldFramework",
        ba.pairing_tag_id IS NULL AS "missingPairing",
        ba.heat_level_tag_id IS NULL AS "missingHeatLevel",
        ba.series_status_tag_id IS NULL AS "missingSeriesStatus",
        ba.consent_mode_tag_id IS NULL AS "missingConsentMode",
        (SELECT state FROM book_assets WHERE book_id = b.id AND asset_type = 'cover' ORDER BY version DESC LIMIT 1) AS "coverState",
        b.created_at AS "createdAt"
      FROM books b
      LEFT JOIN book_axes ba ON ba.book_id = b.id
      WHERE b.status = 'draft'
        AND (
          ba.world_framework_tag_id IS NULL
          OR ba.pairing_tag_id IS NULL
          OR ba.heat_level_tag_id IS NULL
          OR ba.series_status_tag_id IS NULL
          OR ba.consent_mode_tag_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM book_assets WHERE book_id = b.id AND asset_type = 'cover' AND state = 'ready')
        )
      ORDER BY b.created_at DESC
      LIMIT 100;
    `;
    return json({ items: rows });
  }

  // GET /api/vault/admin/queues/needs-evidence
  if (req.method === "GET" && url.pathname === "/api/vault/admin/queues/needs-evidence") {
    const rows = await db/*sql*/`
      SELECT DISTINCT
        b.id::text AS id,
        b.title,
        t.id::text AS "tagId",
        t.name AS "tagName",
        t.category AS "tagCategory"
      FROM books b
      JOIN book_tags bt ON bt.book_id = b.id
      JOIN tags t ON t.id = bt.tag_id
      WHERE t.requires_evidence = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM evidence_links el
          JOIN evidence e ON e.id = el.evidence_id
          WHERE e.book_id = b.id
            AND el.target_type = 'tag'
            AND el.target_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM book_exceptions be
          WHERE be.book_id = b.id
            AND be.rule_id = 'EVIDENCE_REQUIRED_HIGH_STAKES'
            AND (be.expires_at IS NULL OR be.expires_at > NOW())
        )
      ORDER BY b.title
      LIMIT 100;
    `;
    return json({ items: rows });
  }

  // ------------------------------------------------------------------
  // Publishing (Create Snapshot)
  // ------------------------------------------------------------------

  // GET /api/vault/admin/books/:id/publish/preview - Preview what will change
  const publishPreviewMatch = url.pathname.match(/^\/api\/vault\/admin\/books\/([0-9a-fA-F-]{36})\/publish\/preview$/);
  if (publishPreviewMatch && req.method === "GET") {
    const bookId = publishPreviewMatch[1];

    // Get current state
    const bookRows = await db/*sql*/`SELECT * FROM books WHERE id = ${bookId}::uuid;`;
    if (!bookRows.length) return notFound("Book not found");

    const axesRows = await db/*sql*/`SELECT * FROM book_axes WHERE book_id = ${bookId}::uuid;`;
    const tagRows = await db/*sql*/`
      SELECT t.id::text, t.category, t.slug, t.name
      FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
      WHERE bt.book_id = ${bookId}::uuid;
    `;
    const evidenceRows = await db/*sql*/`SELECT id::text, evidence_type, quote_text FROM evidence WHERE book_id = ${bookId}::uuid;`;
    const assetRows = await db/*sql*/`SELECT version, cdn_urls_json FROM book_assets WHERE book_id = ${bookId}::uuid AND asset_type = 'cover' AND state = 'ready' ORDER BY version DESC LIMIT 1;`;

    const axes = axesRows[0] || {};
    const tags: Record<string, any[]> = {};
    for (const t of tagRows) {
      if (!tags[t.category]) tags[t.category] = [];
      tags[t.category].push(t);
    }

    // Validate
    const validation = await computeValidation(db, bookId, {
      worldFramework: axes.world_framework_tag_id,
      pairing: axes.pairing_tag_id,
      heatLevel: axes.heat_level_tag_id,
      seriesStatus: axes.series_status_tag_id,
      consentMode: axes.consent_mode_tag_id,
    }, tags, evidenceRows, { cover: assetRows[0] });

    const canPublish = validation.gates.every((g: any) => g.ok) &&
                       validation.contradictions.filter((c: any) => c.severity === 'hard').length === 0;

    // Get previous publication
    const prevPubRows = await db/*sql*/`
      SELECT id::text AS id, snapshot_json, published_at
      FROM book_publications
      WHERE book_id = ${bookId}::uuid
      ORDER BY published_at DESC
      LIMIT 1;
    `;
    const previousPublication = prevPubRows[0] || null;
    const previousSnapshot = previousPublication?.snapshot_json;

    // Compute detailed diff
    let changes: any = null;
    if (previousSnapshot) {
      const prevTags = Object.values(previousSnapshot.tags || {}).flat() as any[];
      const currTags = Object.values(tags).flat();

      const prevTagIds = new Set(prevTags.map(t => t.id));
      const currTagIds = new Set(currTags.map(t => t.id));

      const addedTags = currTags.filter(t => !prevTagIds.has(t.id));
      const removedTags = prevTags.filter(t => !currTagIds.has(t.id));

      const prevEvidence = (previousSnapshot.evidence || []) as any[];
      const prevEvidenceIds = new Set(prevEvidence.map(e => e.id));
      const currEvidenceIds = new Set(evidenceRows.map((e: any) => e.id));

      const addedEvidence = evidenceRows.filter((e: any) => !prevEvidenceIds.has(e.id));
      const removedEvidence = prevEvidence.filter(e => !currEvidenceIds.has(e.id));

      const coverChanged = (assetRows[0]?.version || 0) !== (previousSnapshot.assets?.cover?.version || 0);

      changes = {
        tags: {
          added: addedTags.map(t => ({ id: t.id, name: t.name, category: t.category })),
          removed: removedTags.map(t => ({ id: t.id, name: t.name, category: t.category })),
        },
        evidence: {
          added: addedEvidence.map((e: any) => ({ id: e.id, type: e.evidence_type, preview: e.quote_text?.slice(0, 50) })),
          removed: removedEvidence.map(e => ({ id: e.id, type: e.evidence_type, preview: e.quote_text?.slice(0, 50) })),
        },
        cover: {
          changed: coverChanged,
          previous_version: previousSnapshot.assets?.cover?.version || null,
          current_version: assetRows[0]?.version || null,
        },
        has_changes: addedTags.length > 0 || removedTags.length > 0 ||
                     addedEvidence.length > 0 || removedEvidence.length > 0 || coverChanged,
      };
    }

    return json({
      can_publish: canPublish,
      validation: {
        gates: validation.gates,
        contradictions: validation.contradictions,
        caps: validation.caps,
      },
      is_republish: !!previousPublication,
      previous_publication: previousPublication ? {
        id: previousPublication.id,
        published_at: previousPublication.published_at,
      } : null,
      changes,
    });
  }

  // POST /api/vault/admin/books/:id/publish
  const publishMatch = url.pathname.match(/^\/api\/vault\/admin\/books\/([0-9a-fA-F-]{36})\/publish$/);
  if (publishMatch && req.method === "POST") {
    const csrfErr = requireCsrf(req, session);
    if (csrfErr) return csrfErr;

    const bookId = publishMatch[1];

    // Load full book data for validation and snapshot
    const bookRows = await db/*sql*/`SELECT * FROM books WHERE id = ${bookId}::uuid;`;
    if (!bookRows.length) return notFound("Book not found");

    const metaRows = await db/*sql*/`SELECT * FROM book_metadata WHERE book_id = ${bookId}::uuid;`;
    const idRows = await db/*sql*/`SELECT * FROM book_identifiers WHERE book_id = ${bookId}::uuid;`;
    const assetRows = await db/*sql*/`SELECT * FROM book_assets WHERE book_id = ${bookId}::uuid AND asset_type = 'cover' AND state = 'ready' ORDER BY version DESC LIMIT 1;`;
    const axesRows = await db/*sql*/`SELECT * FROM book_axes WHERE book_id = ${bookId}::uuid;`;
    const tagRows = await db/*sql*/`
      SELECT t.id, t.category, t.slug, t.name, t.requires_evidence
      FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
      WHERE bt.book_id = ${bookId}::uuid;
    `;
    const evidenceRows = await db/*sql*/`SELECT * FROM evidence WHERE book_id = ${bookId}::uuid;`;
    const quoteRows = await db/*sql*/`SELECT * FROM standout_quotes WHERE book_id = ${bookId}::uuid;`;

    const axes = axesRows[0] || {};
    const tags: Record<string, any[]> = {};
    for (const t of tagRows) {
      if (!tags[t.category]) tags[t.category] = [];
      tags[t.category].push(t);
    }

    // Validate
    const validation = await computeValidation(db, bookId, {
      worldFramework: axes.world_framework_tag_id,
      pairing: axes.pairing_tag_id,
      heatLevel: axes.heat_level_tag_id,
      seriesStatus: axes.series_status_tag_id,
      consentMode: axes.consent_mode_tag_id,
    }, tags, evidenceRows, { cover: assetRows[0] });

    // Check gates
    const failedGates = validation.gates.filter((g: any) => !g.ok);
    if (failedGates.length > 0) {
      return badRequest("Cannot publish: validation failed", { gates: failedGates });
    }

    // Check contradictions
    const hardContradictions = validation.contradictions.filter((c: any) => c.severity === 'hard');
    if (hardContradictions.length > 0) {
      return badRequest("Cannot publish: contradictions exist", { contradictions: hardContradictions });
    }

    // Get taxonomy version
    const taxRows = await db/*sql*/`SELECT id FROM taxonomy_versions WHERE is_active = TRUE LIMIT 1;`;
    const taxonomyVersionId = taxRows[0]?.id;

    if (!taxonomyVersionId) {
      return serverError("No active taxonomy version");
    }

    // Get previous publication for diff computation
    const prevPubRows = await db/*sql*/`
      SELECT id::text AS id, snapshot_json
      FROM book_publications
      WHERE book_id = ${bookId}::uuid
      ORDER BY published_at DESC
      LIMIT 1;
    `;
    const previousPublication = prevPubRows[0] || null;
    const previousSnapshot = previousPublication?.snapshot_json;

    // Create snapshot
    const snapshot = {
      book: bookRows[0],
      metadata: metaRows[0] || {},
      identifiers: idRows[0] || {},
      assets: { cover: assetRows[0] || null },
      axes,
      tags,
      evidence: evidenceRows,
      standoutQuotes: quoteRows,
      publishedAt: new Date().toISOString(),
    };

    // Compute diff summary if this is a re-publish
    let diffSummary: any = null;
    if (previousSnapshot) {
      const prevTags = Object.values(previousSnapshot.tags || {}).flat().map((t: any) => t.id);
      const currTags = Object.values(tags).flat().map((t: any) => t.id);

      const addedTags = currTags.filter((id: string) => !prevTags.includes(id));
      const removedTags = prevTags.filter((id: string) => !currTags.includes(id));

      const prevEvidence = (previousSnapshot.evidence || []).map((e: any) => e.id);
      const currEvidence = evidenceRows.map((e: any) => e.id);
      const addedEvidence = currEvidence.filter((id: string) => !prevEvidence.includes(id));
      const removedEvidence = prevEvidence.filter((id: string) => !currEvidence.includes(id));

      const coverChanged = (assetRows[0]?.version || 0) !== (previousSnapshot.assets?.cover?.version || 0);

      diffSummary = {
        tags_added: addedTags.length,
        tags_removed: removedTags.length,
        evidence_added: addedEvidence.length,
        evidence_removed: removedEvidence.length,
        cover_changed: coverChanged,
        has_changes: addedTags.length > 0 || removedTags.length > 0 ||
                     addedEvidence.length > 0 || removedEvidence.length > 0 || coverChanged,
      };
    }

    const isFirstPublish = !previousPublication;

    // ========================================================================
    // ATOMIC PUBLISH TRANSACTION
    // ========================================================================
    // All publish operations happen inside a transaction to ensure consistency.
    // If any step fails, the entire operation is rolled back.
    //
    // Operations in order:
    // 1. Re-validate inside transaction (authoritative)
    // 2. Insert publication snapshot
    // 3. Update book status
    // 4. Insert audit event

    try {
      const result = await db.transaction(async (txn: any) => {
        // Step 1: Re-validate inside transaction to ensure consistency
        // Check that required axes still exist (could have changed between preview and publish)
        const txnAxes = await txn`SELECT * FROM book_axes WHERE book_id = ${bookId}::uuid;`;
        const axesCheck = txnAxes[0];
        if (!axesCheck ||
            !axesCheck.world_framework_tag_id ||
            !axesCheck.pairing_tag_id ||
            !axesCheck.heat_level_tag_id ||
            !axesCheck.series_status_tag_id ||
            !axesCheck.consent_mode_tag_id) {
          throw new Error('VALIDATION_FAILED:MISSING_AXES');
        }

        // Check cover still exists
        const txnCover = await txn`
          SELECT id FROM book_assets
          WHERE book_id = ${bookId}::uuid AND asset_type = 'cover' AND state = 'ready'
          LIMIT 1;
        `;
        if (!txnCover.length) {
          throw new Error('VALIDATION_FAILED:MISSING_COVER');
        }

        // Step 2: Insert publication snapshot
        const pubRows = await txn`
          INSERT INTO book_publications (
            book_id, taxonomy_version_id, snapshot_json, published_by,
            previous_publication_id, diff_summary_json
          )
          VALUES (
            ${bookId}::uuid,
            ${taxonomyVersionId}::uuid,
            ${JSON.stringify(snapshot)},
            ${session.sub},
            ${previousPublication?.id || null}::uuid,
            ${diffSummary ? JSON.stringify(diffSummary) : null}::jsonb
          )
          RETURNING id::text;
        `;
        const publicationId = pubRows[0].id;

        // Step 3: Update book status
        await txn`
          UPDATE books
          SET status = 'published',
              is_published = TRUE,
              last_published_publication_id = ${publicationId}::uuid,
              first_published_at = COALESCE(first_published_at, NOW()),
              last_published_at = NOW(),
              updated_at = NOW()
          WHERE id = ${bookId}::uuid;
        `;

        // Step 4: Insert audit event
        await txn`
          INSERT INTO events (entity_type, entity_id, event_type, actor_id, diff_json)
          VALUES ('publication', ${publicationId}::uuid, 'PUBLISHED', ${session.sub},
                  ${JSON.stringify({
                    is_republish: !isFirstPublish,
                    previous_publication_id: previousPublication?.id,
                    diff_summary: diffSummary,
                  })}::jsonb);
        `;

        return { publicationId };
      });

      return json({
        ok: true,
        publicationId: result.publicationId,
        isFirstPublish,
        diffSummary,
      });
    } catch (e: any) {
      // Handle validation errors thrown from inside the transaction
      const msg = String(e?.message || e);
      if (msg.includes('VALIDATION_FAILED:MISSING_AXES')) {
        return badRequest("Cannot publish: book data changed - missing required axes. Please refresh and try again.");
      }
      if (msg.includes('VALIDATION_FAILED:MISSING_COVER')) {
        return badRequest("Cannot publish: book data changed - cover no longer exists. Please refresh and try again.");
      }
      return serverError("Failed to publish", { message: msg });
    }
  }

  // GET /api/vault/admin/publications/:id - View a snapshot
  const pubViewMatch = url.pathname.match(/^\/api\/vault\/admin\/publications\/([0-9a-fA-F-]{36})$/);
  if (pubViewMatch && req.method === "GET") {
    const pubId = pubViewMatch[1];
    const rows = await db/*sql*/`
      SELECT id::text, book_id::text AS "bookId", taxonomy_version_id::text AS "taxonomyVersionId",
             snapshot_json AS "snapshot", published_at AS "publishedAt", published_by AS "publishedBy"
      FROM book_publications WHERE id = ${pubId}::uuid;
    `;
    if (!rows.length) return notFound("Publication not found");
    return json(rows[0]);
  }

  // ------------------------------------------------------------------
  // Audit Log
  // ------------------------------------------------------------------

  // GET /api/vault/admin/events
  if (req.method === "GET" && url.pathname === "/api/vault/admin/events") {
    const entityType = url.searchParams.get("entity_type");
    const entityId = url.searchParams.get("entity_id");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);

    let rows;
    if (entityType && entityId) {
      rows = await db/*sql*/`
        SELECT id::text, entity_type AS "entityType", entity_id::text AS "entityId",
               event_type AS "eventType", actor_id AS "actorId", reason, diff_json AS "diff", created_at AS "createdAt"
        FROM events
        WHERE entity_type = ${entityType} AND entity_id = ${entityId}::uuid
        ORDER BY created_at DESC
        LIMIT ${limit};
      `;
    } else {
      rows = await db/*sql*/`
        SELECT id::text, entity_type AS "entityType", entity_id::text AS "entityId",
               event_type AS "eventType", actor_id AS "actorId", reason, diff_json AS "diff", created_at AS "createdAt"
        FROM events
        ORDER BY created_at DESC
        LIMIT ${limit};
      `;
    }
    return json({ items: rows });
  }

  return notFound("Unknown admin route");
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(hash);
  return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}
