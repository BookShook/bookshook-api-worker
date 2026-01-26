/**
 * Generate PBKDF2 hash for admin password
 *
 * Usage:
 *   npx tsx scripts/generate-admin-password.ts "your-password-here"
 *
 * Output: Salt, hash, and iterations to set as Cloudflare secrets
 *
 * IMPORTANT: Must match worker's pbkdf2.ts which uses:
 *   - Base64 encoding (not hex)
 *   - SHA-256 algorithm (not SHA-512)
 */

import crypto from "crypto";

const ITERATIONS = 100000;
const KEY_LENGTH = 32; // 256 bits for SHA-256
const DIGEST = "sha256";

function generateHash(password: string): { salt: string; hash: string; iterations: number } {
  // Generate random salt and encode as base64
  const saltBytes = crypto.randomBytes(32);
  const salt = saltBytes.toString("base64");

  // Hash password with PBKDF2-SHA256, output as base64
  const hashBytes = crypto.pbkdf2Sync(password, saltBytes, ITERATIONS, KEY_LENGTH, DIGEST);
  const hash = hashBytes.toString("base64");

  return { salt, hash, iterations: ITERATIONS };
}

async function main() {
  const password = process.argv[2];

  if (!password) {
    console.log("Usage: npx tsx scripts/generate-admin-password.ts \"your-password-here\"");
    console.log("");
    console.log("Example: npx tsx scripts/generate-admin-password.ts \"MySecurePassword123!\"");
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("Error: Password must be at least 8 characters");
    process.exit(1);
  }

  console.log("\nGenerating PBKDF2 hash...\n");

  const result = generateHash(password);

  console.log("=".repeat(60));
  console.log("ADMIN PASSWORD SECRETS");
  console.log("=".repeat(60));
  console.log("");
  console.log("Add these as secrets in Cloudflare Dashboard:");
  console.log("Workers & Pages → bookshook-api → Settings → Variables → Secrets");
  console.log("");
  console.log(`ADMIN_PBKDF2_SALT=${result.salt}`);
  console.log("");
  console.log(`ADMIN_PBKDF2_HASH=${result.hash}`);
  console.log("");
  console.log(`ADMIN_PBKDF2_ITERS=${result.iterations}`);
  console.log("");
  console.log("=".repeat(60));
  console.log(`Password: ${password}`);
  console.log("=".repeat(60));
  console.log("");
  console.log("IMPORTANT: Save this password somewhere secure!");
  console.log("The hash cannot be reversed to recover the password.");
}

main();
