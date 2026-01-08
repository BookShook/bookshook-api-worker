// Simple sliding-window rate limiter using KV
// Key format: "rl:{scope}:{identifier}" -> JSON { count, windowStart }

type RateLimitResult = { allowed: boolean; remaining: number; resetIn: number };

export async function checkRateLimit(
  kv: KVNamespace,
  scope: string,
  identifier: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const key = `rl:${scope}:${identifier}`;
  const now = Math.floor(Date.now() / 1000);

  const raw = await kv.get(key);
  let data = raw ? JSON.parse(raw) : null;

  // Start fresh window if expired or missing
  if (!data || now - data.windowStart >= windowSeconds) {
    data = { count: 0, windowStart: now };
  }

  const remaining = Math.max(0, limit - data.count);
  const resetIn = windowSeconds - (now - data.windowStart);

  if (data.count >= limit) {
    return { allowed: false, remaining: 0, resetIn };
  }

  // Increment and save
  data.count += 1;
  await kv.put(key, JSON.stringify(data), { expirationTtl: windowSeconds + 60 });

  return { allowed: true, remaining: limit - data.count, resetIn };
}

// Pre-configured limiters for common use cases
export async function checkLoginRateLimit(
  kv: KVNamespace,
  ip: string,
  portal: "admin" | "author"
): Promise<RateLimitResult> {
  // 5 attempts per 15 minutes per IP
  return checkRateLimit(kv, `login:${portal}`, ip, 5, 15 * 60);
}

export async function checkSubmissionRateLimit(
  kv: KVNamespace,
  authorAccountId: string
): Promise<RateLimitResult> {
  // 50 submissions per hour per author
  return checkRateLimit(kv, "submit", authorAccountId, 50, 60 * 60);
}
