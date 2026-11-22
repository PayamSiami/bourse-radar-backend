/**
 * AdminJS Integration for Bourse Radar API
 *
 * Mounts the AdminJS dashboard on the Fastify server at /admin.
 * Resources come from PostgreSQL via @adminjs/sql.
 * Validation is deferred until registerAdminJS() so a missing secret
 * does not crash the API at import time.
 */

import AdminJS from "adminjs";
import AdminJSFastify from "@adminjs/fastify";
import { Adapter, Database, Resource } from "@adminjs/sql";
import type { FastifyInstance } from "fastify";

import { buildAdminResources } from "./resources.js";

let adapterRegistered = false;

function registerAdapter() {
  if (adapterRegistered) return;
  AdminJS.registerAdapter({ Database, Resource });
  adapterRegistered = true;
}

export async function registerAdminJS(app: FastifyInstance) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    app.log.warn("AdminJS skipped: DATABASE_URL is not set");
    return null;
  }

  registerAdapter();

  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\//, ""),
  );

  if (!databaseName) {
    app.log.warn("AdminJS skipped: DATABASE_URL has no database name");
    return null;
  }

  const db = await new Adapter("postgresql", {
    connectionString: databaseUrl,
    database: databaseName,
  }).init();

  const admin = new AdminJS({
    rootPath: "/admin",
    branding: {
      companyName: "Bourse Radar",
      withMadeWithLove: false,
    },
    resources: buildAdminResources(db),
  });

  if (process.env.NODE_ENV !== "production") {
    admin.watch();
  }

  // buildRouter(admin, fastifyApp) mounts GET /admin and the dashboard assets.
  await AdminJSFastify.buildRouter(admin, app);

  app.log.info("AdminJS registered at /admin");

  return admin;
}
