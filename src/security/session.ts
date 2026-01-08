// Minimal signed-cookie session (HMAC-SHA256).
// Cookie format: base64url(payloadJSON) + "." + base64url(signature)

export type SessionPayload = {
  sub: string;      // subject (UUID etc)
  role: string;     // e.g. "curator" | "author"
  exp: number;      // unix seconds
  csrf: string;     // random token for state-changing requests
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
    return payload;
  } catch {
    return null;
  }
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

export function clearCookie(name: string) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
