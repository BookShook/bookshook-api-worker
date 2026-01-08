import { z } from "zod";
import type { Env } from "../db";
import { getDb } from "../db";
import { json, badRequest, unauthorized, forbidden, notFound, serverError, tooManyRequests } from "../lib/respond";
import { verifyPbkdf2Password } from "../security/pbkdf2";
import { parseCookies, verifySession, signSession, makeCookie, clearCookie, randomToken } from "../security/session";
import { requireCsrf } from "../security/csrf";
import { slugify } from "../security/slugify";
import { checkLoginRateLimit } from "../security/ratelimit";
import { validateOrigin } from "../security/origin";

const ADMIN_COOKIE = "bh_admin";

const LoginSchema = z.object({ password: z.string().min(8).max(200) });

async function getAdminSession(req: Request, env: Env) {
  const cookies = parseCookies(req);
  const raw = cookies[ADMIN_COOKIE];
  if (!raw) return null;
  const session = await verifySession(raw, env.SESSION_SECRET);
  if (!session || session.role !== "curator") return null;
  return session;
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
        return tooManyRequests("Too many login attempts. Try again later.", rateCheck.resetIn);
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
      const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 12; // 12h
      const token = await signSession({ sub: "curator", role: "curator", exp, csrf }, env.SESSION_SECRET);

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

  const session = await getAdminSession(req, env);
  if (!session) return unauthorized("Admin login required");

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
  const decideMatch = url.pathname.match(/^\/api\/admin\/proposals\/([0-9a-fA-F-]{36})\/decide$/);
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
  const subDecideMatch = url.pathname.match(/^\/api\/admin\/author-submissions\/([0-9a-fA-F-]{36})\/decide$/);
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

  return notFound("Unknown admin route");
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(hash);
  return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}
