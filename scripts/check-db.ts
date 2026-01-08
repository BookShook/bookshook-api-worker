/**
 * Check current database state
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
    // Check existing tables
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log("Existing tables:");
    for (const row of tables.rows) {
      console.log(`  - ${row.table_name}`);
    }

    // Check users table structure if exists
    const usersExists = tables.rows.some(r => r.table_name === 'users');
    if (usersExists) {
      console.log("\nUsers table columns:");
      const cols = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'users'
        ORDER BY ordinal_position
      `);
      for (const row of cols.rows) {
        console.log(`  - ${row.column_name}: ${row.data_type} (nullable: ${row.is_nullable})`);
      }
    }

    // Check tag_categories
    const tagCatExists = tables.rows.some(r => r.table_name === 'tag_categories');
    if (tagCatExists) {
      console.log("\nTag categories table columns:");
      const cols = await pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'tag_categories'
        ORDER BY ordinal_position
      `);
      for (const row of cols.rows) {
        console.log(`  - ${row.column_name}: ${row.data_type}`);
      }
    }

    // Check books table
    const booksExists = tables.rows.some(r => r.table_name === 'books');
    if (booksExists) {
      console.log("\nBooks table columns:");
      const cols = await pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'books'
        ORDER BY ordinal_position
      `);
      for (const row of cols.rows) {
        console.log(`  - ${row.column_name}: ${row.data_type}`);
      }
    }

  } finally {
    await pool.end();
  }
}

main().catch(console.error);
