/**
 * AdminJS Integration for Bourse Radar API
 * Mounts the AdminJS dashboard at /admin with session-based authentication.
 */

import AdminJS from "adminjs";
import AdminJSFastify from "@adminjs/fastify";
import { Adapter, Database, Resource } from "@adminjs/sql";
import type { FastifyInstance } from "fastify";

// Session store: use fastify-session + connect-pg-simple
// connect-pg-simple v10 can work with fastify-session via the Connect adapter
import FastifySession from "@fastify/session";
import Connect from "connect-pg-simple";

import { timingSafeEqual } from "node:crypto";

import { buildAdminResources } from "./resources.js";
import { closeAdminPool } from "./pool.js";

let adapterRegistered = false;

function registerAdapter() {
  if (adapterRegistered) return;
  AdminJS.registerAdapter({ Database, Resource });
  adapterRegistered = true;
}

function getSessionSecret(): string {
  const secret = process.env.ADMINJS_SESSION_SECRET;
  const isProd = process.env.NODE_ENV === "production";

  if (!secret) {
    if (isProd) {
      throw new Error(
        "ADMINJS_SESSION_SECRET must be set in production (>= 32 chars).",
      );
    }
    return "dev-only-insecure-secret-change-me-please-32";
  }
  if (isProd && secret.length < 32) {
    throw new Error("ADMINJS_SESSION_SECRET must be at least 32 characters.");
  }
  return secret;
}

/**
 * Creates a PostgreSQL-backed session store compatible with @fastify/session.
 *
 * @fastify/session requires a store with:
 *   - get(sessionId, callback)
 *   - set(sessionId, session, callback)
 *   - destroy(sessionId, callback)
 *   - compareAndSet(sessionId, expectedGeneration, session, callback)
 *
 * connect-pg-simple's store does not implement compareAndSet, so we wrap it.
 */
function buildSessionStore(databaseUrl: string) {
  const ConnectSession = Connect(FastifySession as any);
  const pgStore = new ConnectSession({
    conObject: {
      connectionString: databaseUrl,
      // Disable SSL in production if the target PostgreSQL does not support it.
      // Many VPS / managed Postgres setups don't serve TLS on the default port.
      ssl: process.env.NODE_ENV === "production" ? false : undefined,
    },
    tableName: "admin_sessions",
    createTableIfMissing: true,
  });

  // Wrap so @fastify/session's required compareAndSet exists.
  // Generation is stored on the session object by @fastify/session itself;
  // we only need to expose the method. A simple implementation: load, compare
  // generation if present, then set.
  const wrapped: any = {
    get(
      sessionId: string,
      callback: (err: Error | null, session?: any) => void,
    ) {
      pgStore.get(sessionId, callback);
    },
    set(
      sessionId: string,
      session: any,
      callback: (err?: Error | null) => void,
    ) {
      pgStore.set(sessionId, session, callback);
    },
    destroy(sessionId: string, callback: (err?: Error | null) => void) {
      pgStore.destroy(sessionId, callback);
    },
    compareAndSet(
      sessionId: string,
      expectedGeneration: number,
      session: any,
      callback: (err?: Error | null) => void,
    ) {
      pgStore.get(sessionId, (err: Error | null, stored: any) => {
        if (err) return callback(err);
        const storedGeneration =
          stored?.cookie?.generation ?? stored?.generation;
        if (
          stored &&
          storedGeneration !== undefined &&
          storedGeneration !== expectedGeneration
        ) {
          const error = new Error("The session does not exist or has changed");
          (error as any).code = "ENOENT";
          return callback(error);
        }
        pgStore.set(sessionId, session, callback);
      });
    },
  };

  return wrapped as any;
}

export async function registerAdminJS(app: FastifyInstance) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    app.log.warn("AdminJS skipped: DATABASE_URL is not set");
    return null;
  }

  // --- 1. Register the AdminJS SQL adapter ---
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
    db = await new Adapter("postgresql", {
      connectionString: databaseUrl,
      database: databaseName,
    }).init();
    app.log.info("AdminJS DB adapter connected");
  } catch (err) {
    app.log.error({ err }, "AdminJS skipped: DB adapter failed");
    return null;
  }

  // --- 2. Build AdminJS instance ---
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

  // --- 3. Setup session store ---
  let sessionStore;
  try {
    sessionStore = buildSessionStore(databaseUrl);

    // Verify store has required .get method
    if (typeof sessionStore.get !== "function") {
      app.log.error(
        "AdminJS session store missing .get method — cannot proceed",
      );
      return null;
    }
  } catch (err) {
    app.log.error({ err }, "AdminJS skipped: failed to build session store");
    return null;
  }

  // --- 4. Authentication against env credentials ---
  // Login is ADMIN_EMAIL + ADMIN_PASSWORD. Production does not ship a
  // precomputed hash, and a stale hash makes the panel fail only there.
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD ?? "";

  if (!adminEmail || !adminPassword) {
    app.log.error(
      "AdminJS skipped: ADMIN_EMAIL and ADMIN_PASSWORD are required",
    );
    return null;
  }

  const authenticate = async (email: string, password: string) => {
    if (!email || !password) return null;
    if (email.trim().toLowerCase() !== adminEmail) return null;

    const given = Buffer.from(password);
    const expected = Buffer.from(adminPassword);
    const valid =
      given.length === expected.length && timingSafeEqual(given, expected);
    if (!valid) return null;

    return { email: adminEmail, role: "admin" };
  };

  // --- 5. Mount the authenticated router ---
  try {
    await AdminJSFastify.buildAuthenticatedRouter(
      admin,
      {
        authenticate,
        cookiePassword: getSessionSecret(),
        cookieName: "adminjs",
      },
      app,
      {
        store: sessionStore as any,
        saveUninitialized: true,
        secret: getSessionSecret(),
        cookie: {
          httpOnly: true,
          // "auto" sets Secure only on HTTPS. A hard true drops the cookie
          // when production is reached over http or the proxy omits
          // X-Forwarded-Proto, so login succeeds and immediately bounces.
          secure: "auto",
          sameSite: "lax",
          path: "/",
          maxAge: 1000 * 60 * 60 * 8, // 8 hours
        },
      },
    );
  } catch (err) {
    app.log.error({ err }, "AdminJS skipped: buildAuthenticatedRouter failed");
    return null;
  }

  app.addHook("onClose", async () => {
    await closeAdminPool();
  });

  app.log.info("AdminJS registered at /admin (authenticated)");
  return admin;
}
