import { z } from "zod";
import type { Env } from "../db";
import { getDb } from "../db";
import { json, badRequest, unauthorized, serverError, notFound } from "../lib/respond";
import { slugify } from "../security/slugify";

// NOTE: This patch assumes you already have a Ghost-authenticated /api/me endpoint.
// For Day-1, we accept ghost_member_id passed as a header from your existing auth middleware.
// If you already have a stronger member auth, replace `getGhostMemberId` accordingly.

function getGhostMemberId(req: Request): string | null {
  // Your existing worker likely sets this. Options:
  // - header from upstream middleware
  // - cookie decoded from Ghost
  // - JWT
  return req.headers.get("x-ghost-member-id");
}

const CreateProposalSchema = z.object({
  proposal_type: z.enum(["assign_existing", "create_new"]),
  book_id: z.string().uuid().nullable().optional(),
  existing_tag_id: z.string().uuid().nullable().optional(),
  proposed_category_key: z.string().min(1).nullable().optional(),
  proposed_name: z.string().min(2).max(80).nullable().optional(),
  rationale: z.string().max(800).nullable().optional(),
});

const VoteSchema = z.object({
  vote: z.enum(["up", "down"]),
});

export async function handleCommunity(req: Request, env: Env) {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/community/")) return null;

  const db = getDb(env);
  const ghostMemberId = getGhostMemberId(req);
  if (!ghostMemberId) return unauthorized("Sign in required");

  // GET /api/community/proposals?status=pending|eligible|approved|rejected
  if (req.method === "GET" && url.pathname === "/api/community/proposals") {
    const status = url.searchParams.get("status") ?? "pending";
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 100);
    const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);

    const rows = await db/*sql*/`
      SELECT
        p.*,
        t.upvotes, t.downvotes, t.total_votes, t.upvote_ratio,
        (SELECT v.vote FROM tag_proposal_votes v WHERE v.proposal_id = p.id AND v.ghost_member_id = ${ghostMemberId}::uuid) AS my_vote
      FROM tag_proposals p
      LEFT JOIN proposal_vote_totals t ON t.id = p.id
      WHERE p.status = ${status}
      ORDER BY p.created_at DESC
      LIMIT ${limit} OFFSET ${offset};
    `;
    return json({ items: rows, limit, offset });
  }

  // POST /api/community/proposals
  if (req.method === "POST" && url.pathname === "/api/community/proposals") {
    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = CreateProposalSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    const p = parsed.data;
    const isAssign = p.proposal_type === "assign_existing";
    const isCreate = p.proposal_type === "create_new";

    if (isAssign) {
      if (!p.book_id || !p.existing_tag_id) return badRequest("book_id and existing_tag_id are required");
    }
    if (isCreate) {
      if (!p.proposed_category_key || !p.proposed_name) return badRequest("proposed_category_key and proposed_name are required");
    }

    const proposed_slug = isCreate ? slugify(p.proposed_name!) : null;

    try {
      const rows = await db/*sql*/`
        INSERT INTO tag_proposals (
          proposal_type, book_id, existing_tag_id,
          proposed_category_key, proposed_name, proposed_slug,
          rationale, created_by
        )
        VALUES (
          ${p.proposal_type},
          ${p.book_id ?? null}::uuid,
          ${p.existing_tag_id ?? null}::uuid,
          ${p.proposed_category_key ?? null},
          ${p.proposed_name ?? null},
          ${proposed_slug},
          ${p.rationale ?? null},
          ${ghostMemberId}::uuid
        )
        RETURNING *;
      `;
      return json({ item: rows[0] }, { status: 201 });
    } catch (e: any) {
      // Unique index collisions show up here—good UX to surface a friendly message.
      const msg = String(e?.message || e);
      if (msg.includes("uq_proposal_") || msg.includes("duplicate key")) {
        return badRequest("That proposal already exists. Please vote on the existing proposal instead.");
      }
      return serverError("Failed to create proposal", { message: msg });
    }
  }

  // POST /api/community/proposals/:id/vote
  const voteMatch = url.pathname.match(/^\/api\/community\/proposals\/([0-9a-fA-F-]{36})\/vote$/);
  if (voteMatch && req.method === "POST") {
    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("Invalid JSON"); }
    const parsed = VoteSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid payload", parsed.error.flatten());

    const proposalId = voteMatch[1];

    // ensure proposal exists and is votable
    const exists = await db/*sql*/`SELECT id, status FROM tag_proposals WHERE id = ${proposalId}::uuid;`;
    if (!exists.length) return notFound("Proposal not found");
    if (!["pending", "eligible"].includes(exists[0].status)) return badRequest("Voting is closed for this proposal.");

    await db/*sql*/`
      INSERT INTO tag_proposal_votes (proposal_id, ghost_member_id, vote)
      VALUES (${proposalId}::uuid, ${ghostMemberId}::uuid, ${parsed.data.vote})
      ON CONFLICT (proposal_id, ghost_member_id)
      DO UPDATE SET vote = EXCLUDED.vote, created_at = NOW();
    `;

    const totals = await db/*sql*/`SELECT * FROM proposal_vote_totals WHERE id = ${proposalId}::uuid;`;
    return json({ totals: totals[0] });
  }

  return notFound("Unknown community route");
}
