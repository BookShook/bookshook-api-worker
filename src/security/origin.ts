// Origin/Referer validation for mutation requests
// Defense in depth alongside CSRF tokens

const ALLOWED_ORIGINS = [
  "https://bookshook.com",
  "https://www.bookshook.com",
  "https://admin.bookshook.com",
];

export function validateOrigin(req: Request, siteOrigin: string): boolean {
  // Only check mutations (POST, PUT, PATCH, DELETE)
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return true;
  }

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");

  // At least one must be present for mutations
  if (!origin && !referer) {
    return false;
  }

  // Check origin header first (most reliable)
  if (origin) {
    return isAllowedOrigin(origin, siteOrigin);
  }

  // Fall back to referer
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      return isAllowedOrigin(refererOrigin, siteOrigin);
    } catch {
      return false;
    }
  }

  return false;
}

function isAllowedOrigin(origin: string, siteOrigin: string): boolean {
  // Always allow the configured site origin
  if (origin === siteOrigin) return true;

  for (const allowed of ALLOWED_ORIGINS) {
    if (typeof allowed === "string") {
      if (origin === allowed) return true;
    } else if (allowed instanceof RegExp) {
      if (allowed.test(origin)) return true;
    }
  }

  return false;
}
