#!/usr/bin/env node
/**
 * Bourse Radar API — Fastify server bootstrap
 * Tehran Stock Exchange quantitative ranking engine
 *
 * Entry point: `npm run dev` (tsx watch) or `npm start` (compiled JS)
 */

// Load .env FIRST — config Zod schema validates these at import time
import "dotenv/config";

import Fastify from "fastify";
import { config } from "#config";
import { registerPlugins } from "#plugins/index";
import { registerRoutes } from "#routes/index";
import { initializeJobs } from "#jobs/index";
import { runMigrations } from "#db/migrate";

/**
 * A stray rejection must NOT take the API down.
 *
 * Background ingestion fans out across many symbols against rate-limited
 * upstreams (Codal returns 429 under load), so a single orphaned promise was
 * enough to kill the whole server via `process.exit(1)` — taking every read
 * endpoint offline while a supervisor restarted it. Log loudly instead; an
 * `uncaughtException` still exits, since that leaves state undefined.
 */
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION (not fatal):", reason);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});

async function buildServer() {
  const server = Fastify({
    logger: {
      level: config.app.logLevel,
    },
    // /api/stocks == /api/stocks/
    // Must live under routerOptions: the top-level `ignoreTrailingSlash` is
    // deprecated (FSTDEP022) and removed in fastify@6.
    routerOptions: { ignoreTrailingSlash: true },
  });

  await registerPlugins(server);
  console.log("Plugins done, registering routes…");
  await registerRoutes(server);
  console.log("Routes done, scheduling cron jobs…");
  await initializeJobs(server);
  console.log("Jobs done, starting server…");

  return server;
}

async function main() {
  // Apply migrations BEFORE starting to listen. Postgres may not be
  // ready yet in Coolify/Docker, so retry briefly instead of crashing.
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runMigrations();
      break;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      if (attempt === maxAttempts) {
        console.warn(
          `[migrate] failed after ${maxAttempts} attempts — starting without migrations: ${msg}`,
        );
        break;
      }
      const waitMs = Math.min(2000 * attempt, 10000);
      console.warn(
        `[migrate] attempt ${attempt}/${maxAttempts} failed (${msg}) — retrying in ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  const server = await buildServer();

  try {
    await server.listen({ port: config.app.port, host: "0.0.0.0" });
    console.log(
      `Bourse Radar API listening on http://0.0.0.0:${config.app.port}`,
    );
  } catch (err) {
    console.error("Fatal startup error:", err);
    process.exit(1);
  }

  // Graceful shutdown
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}

void main();
