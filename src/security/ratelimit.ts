// Simple sliding-window rate limiter using KV
// Key format: "rl:{scope}:{identifier}" -> JSON { count, windowStart }

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetIn: number;
  limit: number;
  scope: string;
};

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
    return { allowed: false, remaining: 0, resetIn, limit, scope };
  }

  // Increment and save
  data.count += 1;
  await kv.put(key, JSON.stringify(data), { expirationTtl: windowSeconds + 60 });

  return { allowed: true, remaining: limit - data.count, resetIn, limit, scope };
}

// Create a 429 Too Many Requests response with proper headers
export function rateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: "rate_limited",
      message: `Too many requests. Try again in ${result.resetIn} seconds.`,
      retry_after_seconds: result.resetIn,
      limit: result.limit,
      scope: result.scope,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(result.resetIn),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + result.resetIn),
      },
    }
  );
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

export async function checkBookIntakeRateLimit(
  kv: KVNamespace,
  authorAccountId: string
): Promise<RateLimitResult> {
  // 10 book intakes per hour per author
  return checkRateLimit(kv, "book-intake", authorAccountId, 10, 60 * 60);
}
