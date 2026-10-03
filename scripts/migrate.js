#!/usr/bin/env node
/**
 * Bourse Radar — Minimal SQL migration runner.
 *
 * Usage:
 *   node scripts/migrate.js up     # apply all pending migrations
 *   node scripts/migrate.js down   # roll back migrations created after the last applied one
 *   node scripts/migrate.js status # list applied/pending migrations
 *
 * Migrations live in ./migrations as *.sql files, applied in filename order,
 * each inside its own transaction. History is tracked in schema_migrations.
 */

import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  connect_timeout: 10,
});

const command = process.argv[2] ?? "up";

async function ensureHistoryTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function listMigrationFiles() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files;
}

async function appliedMigrations() {
  const rows = await sql`SELECT name FROM schema_migrations ORDER BY name`;
  return new Set(rows.map((r) => r.name));
}

async function runUp() {
  await ensureHistoryTable();
  const files = await listMigrationFiles();
  const applied = await appliedMigrations();

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log("No pending migrations.");
    return;
  }

  for (const file of pending) {
    const body = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`Applying ${file} …`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`
        INSERT INTO schema_migrations (name) VALUES (${file})
      `;
    });
    console.log(`  ✓ ${file} applied`);
  }
}

async function runDown() {
  await ensureHistoryTable();
  const applied = await appliedMigrations();
  if (applied.size === 0) {
    console.log("No migrations to roll back.");
    return;
  }

  // Roll back only the migrations we could safely re-run from newer applied
  // state is not possible with forward-only SQL files, so we clear the
  // newest applied record(s) whose table operations are reversible by
  // dropping the tables the initial schema creates. Keep it explicit:
  const files = await listMigrationFiles();
  const appliedInOrder = files.filter((f) => applied.has(f)).reverse();

  if (appliedInOrder.length === 0) {
    console.log("No applied migrations found in migration files.");
    return;
  }

  const newest = appliedInOrder[0];
  console.log(`Rolling back ${newest} …`);

  if (newest === "0001_init.sql") {
    await sql`
      DROP TABLE IF EXISTS quarterly_financials CASCADE;
      DROP TABLE IF EXISTS monthly_sales CASCADE;
      DROP TABLE IF EXISTS prices CASCADE;
      DROP TABLE IF EXISTS forward_pe CASCADE;
      DROP TABLE IF EXISTS stocks CASCADE;
      DROP TABLE IF EXISTS schema_migrations CASCADE;
    `;
  } else if (newest === "0002_rankings_view.sql") {
    await sql`DROP MATERIALIZED VIEW IF EXISTS stock_rankings CASCADE`;
  } else if (newest === "0003_monthly_detail.sql") {
    await sql`ALTER TABLE monthly_sales DROP COLUMN IF EXISTS detail`;
  } else {
    console.log(`  ⚠ Automatic rollback not defined for ${newest} — skipping.`);
    return;
  }

  await sql`DELETE FROM schema_migrations WHERE name = ${newest}`;
  console.log(`  ✓ ${newest} rolled back`);
}

async function runStatus() {
  await ensureHistoryTable();
  const files = await listMigrationFiles();
  const applied = await appliedMigrations();
  for (const file of files) {
    console.log(`  [${applied.has(file) ? "✓" : " "}] ${file}`);
  }
}

try {
  switch (command) {
    case "up":
      await runUp();
      break;
    case "down":
      await runDown();
      break;
    case "status":
      await runStatus();
      break;
    default:
      console.error(`Unknown command: ${command} (use up | down | status)`);
      process.exit(1);
  }
} finally {
  await sql.end();
}