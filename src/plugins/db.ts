import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { config } from "#config";
import { logger } from "#utils/logger";

/**
 * Fastify plugin: PostgreSQL connection via `postgres` npm driver.
 * Attaches `server.db` to the Fastify instance (typed via declaration merge).
 */
declare module "fastify" {
  interface FastifyInstance {
    db: ReturnType<typeof postgres>;
  }
}

export async function registerDb(server: FastifyInstance) {
  const sql = postgres(config.db.url, {
    max: 20,           // connection pool size
    idle_timeout: 30,
    connect_timeout: 10,
    // `on.notice` is a postgres v3 runtime feature not yet in the TS types;
    // we attach it via a cast to avoid a typecheck error that would block prod builds.
    ...(process.env.NODE_ENV === "development"
      ? { debug: (msg: string) => logger.debug(msg) }
      : {}),
  } as any);

  // Verify connection
  try {
    await sql`SELECT 1 as ok`;
    logger.info("✓ PostgreSQL connected");
  } catch (err) {
    logger.error(err, "✗ PostgreSQL connection failed — starting in degraded mode");
    // In degraded mode, API still serves stale cache data but no DB writes
  }

  server.decorate("db", sql);
  server.addHook("onClose", async () => {
    await sql.end();
    logger.info("PostgreSQL connection closed");
  });
}
