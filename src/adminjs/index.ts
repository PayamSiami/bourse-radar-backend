/**
 * AdminJS Integration for Bourse Radar API
 *
 * Mounts the AdminJS dashboard on the Fastify server at /admin.
 * Resources come from PostgreSQL via @adminjs/sql.
 *
 * IMPORTANT: @adminjs/fastify requires @fastify/cookie + @fastify/session
 * to be registered BEFORE buildRouter(), otherwise /admin is not mounted.
 */

import AdminJS from "adminjs";
import AdminJSFastify from "@adminjs/fastify";
import { Adapter, Database, Resource } from "@adminjs/sql";
import type { FastifyInstance } from "fastify";

import cookie from "@fastify/cookie";
import session from "@fastify/session";
import formbody from "@fastify/formbody";

import { buildAdminResources } from "./resources.js";

let adapterRegistered = false;

function registerAdapter() {
  if (adapterRegistered) return;
  AdminJS.registerAdapter({ Database, Resource });
  adapterRegistered = true;
}

/**
 * Returns the session secret, or throws in production if it is missing.
 */
function getSessionSecret(): string {
  const secret = process.env.ADMINJS_SESSION_SECRET;
  const isProd = process.env.NODE_ENV === "production";

  if (!secret) {
    if (isProd) {
      throw new Error(
        "ADMINJS_SESSION_SECRET must be set in production (>= 32 chars).",
      );
    }
    // Dev-only fallback — never use in production.
    return "dev-only-insecure-secret-change-me-please-32";
  }

  if (isProd && secret.length < 32) {
    throw new Error("ADMINJS_SESSION_SECRET must be at least 32 characters.");
  }

  return secret;
}

/**
 * Register the Fastify plugins AdminJS depends on.
 * Idempotent via a symbol on the instance.
 */
async function ensureAdminPlugins(app: FastifyInstance) {
  const key = Symbol.for("adminjs.plugins.registered");
  if ((app as any)[key]) return;
  (app as any)[key] = true;

  await app.register(cookie);

  await app.register(session, {
    secret: getSessionSecret(),
    cookieName: "adminjs",
    cookie: {
      // `secure: true` requires HTTPS AND trustProxy enabled on Fastify.
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  });

  await app.register(formbody);
}

export async function registerAdminJS(app: FastifyInstance) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    app.log.warn("AdminJS skipped: DATABASE_URL is not set");
    return null;
  }

  // --- 1. Register required Fastify plugins FIRST -------------------------
  try {
    await ensureAdminPlugins(app);
  } catch (err) {
    app.log.error(
      { err },
      "AdminJS skipped: failed to register session plugins",
    );
    return null;
  }

  // --- 2. Register the AdminJS SQL adapter --------------------------------
  registerAdapter();

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(
      new URL(databaseUrl).pathname.replace(/^\//, ""),
    );
  } catch (err) {
    app.log.error({ err }, "AdminJS skipped: DATABASE_URL is not a valid URL");
    return null;
  }

  if (!databaseName) {
    app.log.warn("AdminJS skipped: DATABASE_URL has no database name");
    return null;
  }

  let db: Awaited<ReturnType<Adapter["init"]>>;
  try {
    // Determine SSL config: use connection string's SSL params if present,
    // otherwise disable SSL in development, enable with default settings in production.
    // Note: pg accepts `ssl: boolean | tls.ConnectionOptions`.
    // For self-signed certs in production, set PGSSLROOTCERT or use a proper TLS config.
    const isProd = process.env.NODE_ENV === "production";
    const sslConfig = isProd ? true : false;

    db = await new Adapter("postgresql", {
      connectionString: databaseUrl,
      database: databaseName,
      ssl: sslConfig,
    }).init();
    app.log.info("AdminJS DB adapter connected");
  } catch (err) {
    app.log.error({ err }, "AdminJS skipped: DB adapter failed");
    return null;
  }

  // --- 3. Build AdminJS instance -----------------------------------------
  let admin: AdminJS;
  try {
    admin = new AdminJS({
      rootPath: "/admin",
      branding: {
        companyName: "Bourse Radar",
        withMadeWithLove: false,
      },
      resources: buildAdminResources(db),
    });
  } catch (err) {
    app.log.error({ err }, "AdminJS skipped: failed to construct AdminJS");
    return null;
  }

  if (process.env.NODE_ENV !== "production") {
    admin.watch();
  }

  // --- 4. Mount the router -----------------------------------------------
  try {
    await AdminJSFastify.buildRouter(admin, app);
  } catch (err) {
    app.log.error({ err }, "AdminJS skipped: buildRouter failed");
    return null;
  }

  app.log.info("AdminJS registered at /admin");
  return admin;
}