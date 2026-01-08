import { neon, neonConfig } from "@neondatabase/serverless";

export type Env = {
  NEON_DATABASE_URL: string;
  SITE_ORIGIN: string;
  SESSION_SECRET: string;
  ADMIN_PBKDF2_SALT: string;
  ADMIN_PBKDF2_HASH: string;
  ADMIN_PBKDF2_ITERS?: string;
  RATE_LIMIT: KVNamespace;
};

// Recommended for serverless; keeps fetch-based connections efficient.
neonConfig.fetchConnectionCache = true;

export function getDb(env: Env) {
  if (!env.NEON_DATABASE_URL) {
    throw new Error("Missing env.NEON_DATABASE_URL");
  }
  return neon(env.NEON_DATABASE_URL);
}
