/**
 * Migration Runner for Neon Postgres
 *
 * Usage:
 *   npx tsx scripts/run-migration.ts db/migrations/002_taxonomy_seed.sql
 *   npx tsx scripts/run-migration.ts db/migrations/003_ku_snapshot.sql
 *   npx tsx scripts/run-migration.ts --all   # runs all migrations in order
 *
 * Requires NEON_DATABASE_URL env var (or .dev.vars file)
 */

import { Pool } from "@neondatabase/serverless";
import * as fs from "fs";
import * as path from "path";

// Load .dev.vars if present (Wrangler secrets file)
function loadDevVars(): void {
  const devVarsPath = path.join(process.cwd(), ".dev.vars");
  if (fs.existsSync(devVarsPath)) {
    const content = fs.readFileSync(devVarsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
    console.log("Loaded .dev.vars");
  }
}

async function runMigration(filePath: string): Promise<void> {
  const dbUrl = process.env.NEON_DATABASE_URL;
  if (!dbUrl) {
    throw new Error("NEON_DATABASE_URL environment variable is required");
  }

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Migration file not found: ${absolutePath}`);
  }

  const pool = new Pool({ connectionString: dbUrl });
  const content = fs.readFileSync(absolutePath, "utf-8");

  console.log(`\nRunning migration: ${path.basename(filePath)}`);
  console.log("─".repeat(50));

  const startTime = Date.now();

  try {
    // Execute the entire SQL file
    await pool.query(content);

    const elapsed = Date.now() - startTime;
    console.log(`Migration completed in ${elapsed}ms`);
  } catch (error: any) {
    console.error(`Migration failed: ${error.message}`);
    if (error.detail) {
      console.error("Detail:", error.detail);
    }
    if (error.hint) {
      console.error("Hint:", error.hint);
    }
    if (error.where) {
      console.error("Where:", error.where);
    }
    throw error;
  } finally {
    await pool.end();
  }
}

async function runAllMigrations(): Promise<void> {
  const migrationsDir = path.join(process.cwd(), "db", "migrations");

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort(); // Sort alphabetically (001_, 002_, etc.)

  if (files.length === 0) {
    console.log("No migration files found.");
    return;
  }

  console.log(`Found ${files.length} migration(s):`);
  files.forEach(f => console.log(`  - ${f}`));

  for (const file of files) {
    await runMigration(path.join(migrationsDir, file));
  }

  console.log("\nAll migrations completed.");
}

async function main(): Promise<void> {
  loadDevVars();

  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage:");
    console.log("  npx tsx scripts/run-migration.ts <file.sql>");
    console.log("  npx tsx scripts/run-migration.ts --all");
    console.log("");
    console.log("Examples:");
    console.log("  npx tsx scripts/run-migration.ts db/migrations/002_taxonomy_seed.sql");
    console.log("  npx tsx scripts/run-migration.ts --all");
    process.exit(1);
  }

  if (args[0] === "--all") {
    await runAllMigrations();
  } else {
    for (const file of args) {
      await runMigration(file);
    }
  }
}

main().catch((err) => {
  console.error("\nMigration failed:", err.message);
  process.exit(1);
});
