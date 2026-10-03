/**
 * Bourse Radar — migration runner usable from src/index.ts
 *
 * Mirrors scripts/migrate.js (the standalone CLI) but exports
 * `runMigrations()` so the Fastify bootstrap can auto-apply
 * pending *.sql files on startup (Coolify / Docker).
 *
 * Idempotent: re-runs are no-ops thanks to schema_migrations
 * + every *.sql is written with IF NOT EXISTS.
 */

import "dotenv/config";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import postgres from "postgres";

function findMigrationsDir(): string {
  // import.meta.url is src/db/migrate.ts in dev and dist/src/db/migrate.js in prod.
  // Try both depths plus cwd fallback.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dev: src/db -> project root
    resolve(here, "../../migrations"),
    // prod: dist/src/db -> /app
    resolve(here, "../../../migrations"),
    resolve(process.cwd(), "migrations"),
    "/app/migrations",
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p) && readdirSync(p).length >= 0) return p;
    } catch {
      // try next
    }
  }
  // fallback: first candidate (caller will see ENOENT)
  return candidates[0]!;
}

async function ensureHistoryTable(
  sql: postgres.Sql,
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function listMigrationFiles(dir: string): Promise<string[]> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function appliedMigrations(
  sql: postgres.Sql,
): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
  return new Set(rows.map((r) => r.name));
}

/**
 * Apply all pending migrations in filename order, each in its own
 * transaction. Safe to call on every startup.
 */
export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn("[migrate] DATABASE_URL not set — skipping migrations");
    return;
  }

  const dir = findMigrationsDir();
  if (!existsSync(dir)) {
    console.warn(`[migrate] migrations dir not found: ${dir} — skipping`);
    return;
  }

  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });

  try {
    await ensureHistoryTable(sql);
    const files = await listMigrationFiles(dir);
    const applied = await appliedMigrations(sql);
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log("[migrate] No pending migrations");
      return;
    }

    console.log(`[migrate] Applying ${pending.length} migration(s) from ${dir}`);
    for (const file of pending) {
      const body = readFileSync(join(dir, file), "utf8");
      console.log(`[migrate] → ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
      console.log(`[migrate] ✓ ${file}`);
    }
    console.log("[migrate] Done");
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}
