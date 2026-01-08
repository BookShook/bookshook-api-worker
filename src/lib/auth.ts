/**
 * Auth helpers for premium endpoints
 */

export type AuthenticatedUser = {
  ghostMemberId: string;
  email: string;
  name: string | null;
  isPaid: boolean;
};

export type AuthResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; status: number; error: string; code: string };

/**
 * Verifies the user session via Ghost Members API.
 * Returns the authenticated user or an error response.
 */
export async function getAuthenticatedUser(
  request: Request,
  siteOrigin: string
): Promise<AuthResult> {
  const cookie = request.headers.get("cookie") ?? "";

  if (!cookie) {
    return { ok: false, status: 401, error: "Not authenticated", code: "NOT_AUTHENTICATED" };
  }

  try {
    const ghostUrl = new URL("/members/api/member", siteOrigin);

    const res = await fetch(ghostUrl.toString(), {
      method: "GET",
      headers: {
        cookie,
        accept: "application/json",
        "user-agent": "BookShookVaultWorker/1.0",
      },
    });

    if (res.status === 204 || res.status === 401) {
      return { ok: false, status: 401, error: "Not authenticated", code: "NOT_AUTHENTICATED" };
    }

    if (!res.ok) {
      return { ok: false, status: 401, error: "Not authenticated", code: "NOT_AUTHENTICATED" };
    }

    const raw = (await res.json().catch(() => null)) as any;
    const member = raw?.member ?? raw;

    if (!member?.uuid) {
      return { ok: false, status: 401, error: "Not authenticated", code: "NOT_AUTHENTICATED" };
    }

    const tiers = Array.isArray(member?.tiers) ? member.tiers : [];
    const status = (member?.status ?? "").toLowerCase();
    const isPaid = status === "paid" || status === "comped" || tiers.length > 0;

    return {
      ok: true,
      user: {
        ghostMemberId: member.uuid,
        email: member.email,
        name: member.name ?? null,
        isPaid,
      },
    };
  } catch {
    return { ok: false, status: 401, error: "Not authenticated", code: "NOT_AUTHENTICATED" };
  }
}

/**
 * Requires the user to be authenticated AND have a paid subscription.
 */
export async function requirePaidUser(
  request: Request,
  siteOrigin: string
): Promise<AuthResult> {
  const result = await getAuthenticatedUser(request, siteOrigin);

  if (!result.ok) {
    return result;
  }

  if (!result.user.isPaid) {
    return { ok: false, status: 402, error: "Premium feature", code: "PREMIUM_REQUIRED" };
  }

  return result;
}

/**
 * JSON error response helper
 */
export function jsonError(status: number, error: string, code: string): Response {
  return new Response(
    JSON.stringify({ error, code }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        vary: "cookie",
      },
    }
  );
}

/**
 * JSON success response helper
 */
export function jsonSuccess(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      vary: "cookie",
    },
  });
}
