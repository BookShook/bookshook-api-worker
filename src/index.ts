import { handleGetBooks, handleGetBookBySlug } from "./routes/books";
import { handleGetTags } from "./routes/tags";
import { handleGetCollections, handleGetCollectionBySlug } from "./routes/collections";
import {
  handleGetBookInteractions,
  handlePostInteraction,
  handleDeleteInteraction,
} from "./routes/interactions";
import { handleGetMyLibrary } from "./routes/library";
import { handleGetRecommendations } from "./routes/recommendations";
import { handleCommunity } from "./routes/community";
import { handleAuthor } from "./routes/author";
import { handleAdmin } from "./routes/admin";
import type { Env } from "./db";

// CORS allowed origins
const ALLOWED_ORIGINS = [
  "https://bookshook.com",
  "https://www.bookshook.com",
];

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.includes(origin);
}

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  const allowedOrigin = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cookie, x-ghost-member-id, x-csrf-token",
    "Access-Control-Allow-Credentials": "true",
  };
}

function json(body: unknown, init: ResponseInit = {}, request?: Request) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  headers.set("vary", "cookie, origin");

  // Add CORS headers
  if (request) {
    const cors = getCorsHeaders(request);
    for (const [key, value] of Object.entries(cors)) {
      headers.set(key, value);
    }
  }

  return new Response(JSON.stringify(body), { ...init, headers });
}

async function withCors(request: Request, handler: () => Promise<Response>): Promise<Response> {
  const response = await handler();
  const newHeaders = new Headers(response.headers);
  const cors = getCorsHeaders(request);
  for (const [key, value] of Object.entries(cors)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

function deriveIsPaid(status?: string, tiers?: Array<any>): boolean {
  const s = (status ?? "").toLowerCase();
  if (s === "paid" || s === "comped") return true;
  if (Array.isArray(tiers) && tiers.length > 0) return true;
  return false;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request),
      });
    }

    // Health checks
    if (url.pathname === "/api/health" || url.pathname === "/health") {
      return json({ ok: true }, { status: 200 }, request);
    }

    // Tags endpoint
    if (url.pathname === "/api/tags") {
      return withCors(request, () => handleGetTags(request, env));
    }

    // Books list
    if (url.pathname === "/api/books") {
      return withCors(request, () => handleGetBooks(request, env));
    }

    // Book detail by slug
    if (url.pathname.startsWith("/api/books/")) {
      const slug = decodeURIComponent(url.pathname.slice("/api/books/".length));
      return withCors(request, () => handleGetBookBySlug(request, env, slug));
    }

    // Collections list
    if (url.pathname === "/api/collections") {
      return withCors(request, () => handleGetCollections(request, env));
    }

    // Collection detail by slug
    if (url.pathname.startsWith("/api/collections/")) {
      const slug = decodeURIComponent(url.pathname.slice("/api/collections/".length));
      return withCors(request, () => handleGetCollectionBySlug(request, env, slug));
    }

    // Premium: Interactions
    if (url.pathname === "/api/interactions" && request.method === "POST") {
      return withCors(request, () => handlePostInteraction(request, env));
    }
    if (url.pathname === "/api/interactions" && request.method === "DELETE") {
      return withCors(request, () => handleDeleteInteraction(request, env));
    }
    if (url.pathname.startsWith("/api/interactions/") && request.method === "GET") {
      const bookId = decodeURIComponent(url.pathname.slice("/api/interactions/".length));
      return withCors(request, () => handleGetBookInteractions(request, env, bookId));
    }

    // Premium: My Library
    if (url.pathname === "/api/my/library" && request.method === "GET") {
      return withCors(request, () => handleGetMyLibrary(request, env));
    }

    // Premium: Recommendations
    if (url.pathname === "/api/recommendations" && request.method === "GET") {
      return withCors(request, () => handleGetRecommendations(request, env));
    }

    // Auth primitive
    if (url.pathname === "/api/me" && request.method === "GET") {
      try {
        const cookie = request.headers.get("cookie") ?? "";
        if (!cookie) return json({ isAuthenticated: false }, { status: 200 }, request);

        // Ask Ghost to verify the current session via members API
        const ghostUrl = new URL("/members/api/member", env.SITE_ORIGIN);

        const res = await fetch(ghostUrl.toString(), {
          method: "GET",
          headers: {
            cookie,
            accept: "application/json",
            "user-agent": "BookShookVaultWorker/1.0"
          }
        });

        // Ghost returns 204 when not authenticated
        if (res.status === 204 || res.status === 401) {
          return json({ isAuthenticated: false }, { status: 200 }, request);
        }

        if (!res.ok) {
          // Fail closed (treat as unauth)
          return json({ isAuthenticated: false }, { status: 200 }, request);
        }

        const raw = await res.json().catch(() => null) as any;

        // Ghost may return { member: {...} } or the object directly
        const member = raw?.member ?? raw;

        const tiers = Array.isArray(member?.tiers)
          ? member.tiers.map((t: any) => ({ id: t?.id, name: t?.name, slug: t?.slug }))
          : [];

        const body = {
          isAuthenticated: true,
          ghostMemberId: member?.uuid,
          email: member?.email,
          name: member?.name,
          status: member?.status,
          tiers,
          isPaid: deriveIsPaid(member?.status, tiers)
        };

        // If uuid missing, treat as unauth
        if (!body.ghostMemberId) return json({ isAuthenticated: false }, { status: 200 }, request);

        return json(body, { status: 200 }, request);
      } catch {
        return json({ isAuthenticated: false }, { status: 200 }, request);
      }
    }

    // Community routes (requires Ghost member auth via x-ghost-member-id header)
    if (url.pathname.startsWith("/api/community/")) {
      const res = await handleCommunity(request, env);
      if (res) return withCors(request, async () => res);
    }

    // Author portal routes (under /vault/ for same-origin)
    if (url.pathname.startsWith("/api/vault/author/")) {
      const res = await handleAuthor(request, env);
      if (res) return withCors(request, async () => res);
    }

    // Admin routes (under /vault/ for same-origin)
    if (url.pathname.startsWith("/api/vault/admin/")) {
      const res = await handleAdmin(request, env);
      if (res) return withCors(request, async () => res);
    }

    return new Response("404 Not Found", { status: 404, headers: getCorsHeaders(request) });
  }
};
