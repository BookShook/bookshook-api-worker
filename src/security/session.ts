// Minimal signed-cookie session (HMAC-SHA256).
// Cookie format: base64url(payloadJSON) + "." + base64url(signature)

export type SessionPayload = {
  sub: string;      // subject (UUID etc)
  role: string;     // e.g. "curator" | "author"
  exp: number;      // unix seconds (expiration)
  iat: number;      // unix seconds (issued at) - for time-based revocation
  jti: string;      // JWT ID - for specific session revocation
  csrf: string;     // random token for state-changing requests
};

// Revocation check result
export type RevocationCheck = {
  revoked: boolean;
  reason?: string;
};

const te = new TextEncoder();

function b64url(bytes: Uint8Array) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function ub64url(s: string) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(data));
  return new Uint8Array(sig);
}

export function randomToken(bytes = 24) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return b64url(arr);
}

export async function signSession(payload: SessionPayload, secret: string) {
  const body = b64url(te.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(secret, body));
  return `${body}.${sig}`;
}

export async function verifySession(token: string, secret: string): Promise<SessionPayload | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = await hmac(secret, body);
  const provided = ub64url(sig);
  if (provided.length !== expected.length) return null;

  // constant-time compare
  let ok = 1;
  for (let i = 0; i < expected.length; i++) ok &= (expected[i] === provided[i]) ? 1 : 0;
  if (!ok) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(ub64url(body))) as SessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (!payload?.exp || payload.exp < now) return null;
    if (!payload?.sub || !payload?.role || !payload?.csrf) return null;
    // jti and iat are optional for backwards compatibility with existing sessions
    // New sessions will have them
    return payload;
  } catch {
    return null;
  }
}

// Check if a session has been revoked
// Should be called after verifySession succeeds
export async function checkSessionRevoked(
  db: any,
  session: SessionPayload
): Promise<RevocationCheck> {
  // Check specific JTI revocation
  if (session.jti) {
    const jtiRevoked = await db/*sql*/`
      SELECT reason FROM session_revocations
      WHERE jti = ${session.jti}
      LIMIT 1;
    `;
    if (jtiRevoked.length > 0) {
      return { revoked: true, reason: jtiRevoked[0].reason || "Session revoked" };
    }
  }

  // Check subject-wide revocation (sessions issued before revocation time are invalid)
  if (session.iat) {
    const subjectRevoked = await db/*sql*/`
      SELECT reason, revoke_sessions_before FROM session_revocations
      WHERE subject = ${session.sub}
        AND jti IS NULL
        AND revoke_sessions_before IS NOT NULL
        AND revoke_sessions_before > to_timestamp(${session.iat})
      ORDER BY revoke_sessions_before DESC
      LIMIT 1;
    `;
    if (subjectRevoked.length > 0) {
      return { revoked: true, reason: subjectRevoked[0].reason || "All sessions revoked" };
    }
  }

  return { revoked: false };
}

// Revoke a specific session by JTI
export async function revokeSession(
  db: any,
  jti: string,
  subject: string,
  revokedBy: string,
  reason?: string
): Promise<void> {
  await db/*sql*/`
    INSERT INTO session_revocations (jti, subject, revoked_by, reason)
    VALUES (${jti}, ${subject}, ${revokedBy}, ${reason || 'Manual revocation'});
  `;
}

// Revoke all sessions for a subject (e.g., "log out all devices")
export async function revokeAllSessions(
  db: any,
  subject: string,
  revokedBy: string,
  reason?: string
): Promise<void> {
  await db/*sql*/`
    INSERT INTO session_revocations (subject, revoked_by, reason, revoke_sessions_before)
    VALUES (${subject}, ${revokedBy}, ${reason || 'All sessions revoked'}, NOW());
  `;
}

// Generate a unique session ID (JTI)
export function generateJti(): string {
  return randomToken(16);
}

export function parseCookies(req: Request) {
  const header = req.headers.get("cookie") || "";
  const out: Record<string, string> = {};
  header.split(";").forEach(part => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = rest.join("=");
  });
  return out;
}

export function makeCookie(name: string, value: string, opts: {
  maxAgeSeconds?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
} = {}) {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAgeSeconds != null) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  if (opts.httpOnly ?? true) parts.push("HttpOnly");
  if (opts.secure ?? true) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Strict"}`);
  return parts.join("; ");
}

export function clearCookie(name: string, opts: {
  path?: string;
  sameSite?: "Strict" | "Lax" | "None";
} = {}) {
  const path = opts.path ?? "/";
  const sameSite = opts.sameSite ?? "Strict";
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=${sameSite}`;
}
