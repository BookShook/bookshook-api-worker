/**
 * Fix tags table constraints
 */
import { Pool } from "@neondatabase/serverless";
import * as fs from "fs";
import * as path from "path";

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
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

async function main(): Promise<void> {
  loadDevVars();

  const dbUrl = process.env.NEON_DATABASE_URL;
  if (!dbUrl) {
    throw new Error("NEON_DATABASE_URL required");
  }

  const pool = new Pool({ connectionString: dbUrl });

  try {
    // Check existing indexes on tags table
    console.log("Existing indexes on tags table:");
    const indexes = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'tags'
    `);
    for (const row of indexes.rows) {
      console.log(`  - ${row.indexname}: ${row.indexdef}`);
    }

    // Check existing constraints
    console.log("\nExisting constraints on tags table:");
    const constraints = await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid = 'tags'::regclass
    `);
    for (const row of constraints.rows) {
      console.log(`  - ${row.conname} (${row.contype}): ${row.pg_get_constraintdef}`);
    }

    // Check existing tags
    console.log("\nExisting tags:");
    const tags = await pool.query(`
      SELECT id, slug, category, name
      FROM tags
      ORDER BY slug
      LIMIT 20
    `);
    for (const row of tags.rows) {
      console.log(`  - ${row.slug} (${row.category || 'no category'}): ${row.name || 'no name'}`);
    }

    // Drop the unique slug constraint if it exists
    console.log("\nDropping tags_slug_uq_idx if exists...");
    try {
      await pool.query(`DROP INDEX IF EXISTS tags_slug_uq_idx`);
      console.log("  Dropped tags_slug_uq_idx");
    } catch (e: any) {
      console.log(`  Could not drop: ${e.message}`);
    }

    // Also check for other slug-only unique constraints
    const slugIdx = indexes.rows.find(r =>
      r.indexdef.includes('UNIQUE') &&
      r.indexdef.includes('slug') &&
      !r.indexdef.includes('category')
    );
    if (slugIdx) {
      console.log(`  Found slug-only unique index: ${slugIdx.indexname}`);
      try {
        await pool.query(`DROP INDEX IF EXISTS "${slugIdx.indexname}"`);
        console.log(`  Dropped ${slugIdx.indexname}`);
      } catch (e: any) {
        console.log(`  Could not drop: ${e.message}`);
      }
    }

    console.log("\nDone. Now you can re-run the taxonomy seed migration.");

  } finally {
    await pool.end();
  }
}

main().catch(console.error);
