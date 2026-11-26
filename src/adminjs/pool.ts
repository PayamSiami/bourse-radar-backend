/**
 * Dedicated pg.Pool for AdminJS sessions + admin authentication.
 * Kept separate from the API's data access so it can be reused by
 * connect-pg-simple without pulling in app-specific config.
 */
import pg from "pg";

let pool: pg.Pool | null = null;

export function getAdminPool(): pg.Pool {
  if (pool) return pool;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set — cannot create AdminJS pool");
  }

  pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  });

  return pool;
}

export async function closeAdminPool(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}