import type { FastifyInstance } from "fastify";
import { registerStocksRoutes } from "#routes/stocks";
import { registerRankingsRoutes } from "#routes/rankings";
import { registerSuggestionsRoutes } from "#routes/suggestions.routes";
import { registerHealthRoute } from "#routes/health";
import { registerSalesTrendsRoutes } from "#routes/sales-trends";
import { registerIngestRoutes } from "#routes/registerIngest.routes";
import { registerSectorAssetsRoutes } from "#routes/sector-assets";
import { registerSectorsRoutes } from "#routes/sectors";
import { registerPriceHistoryRoutes } from "#routes/price-history";
import { registerQuarterlyRoutes } from "#routes/quarterly";
import { registerEarningsRoutes } from "#routes/earnings";
import { registerMcapRoutes } from "#routes/mcap-series";
import { registerOrderBookRoutes } from "#routes/orderbook";
import { registerTicketsRoutes } from "#routes/tickets";
import { registerAuthRoutes } from "#routes/auth";
import { registerAdminRoutes } from "#routes/admin";

type RouteRegistrar = (server: FastifyInstance) => void | Promise<void>;

interface RouteDefinition {
  name: string;
  register: RouteRegistrar;
  /** When true, a failure will be logged but not rethrown IN DEV ONLY. */
  optional?: boolean;
}

export async function registerRoutes(server: FastifyInstance) {
  const isProd = process.env.NODE_ENV === "production";

  server.log.info("registering routes");

  // Global response headers. Must RETURN payload — async onSend that
  // omits the return value silently replaces the body with undefined
  // in some Fastify versions.
  server.addHook("onSend", async (req, reply, payload) => {
    const now = Date.now();
    reply.header("X-Server-Timestamp", new Date(now).toISOString());
    reply.header("X-Server-Time", Math.floor(now / 1000));
    reply.header("X-Request-Id", req.id);
    return payload;
  });

  const routes: RouteDefinition[] = [
    { name: "Health",        register: (s) => registerHealthRoute(s) },

    // ── Reference / static list routes FIRST (no param collision) ──
    {
      name: "Sectors",
      // Static route: /api/sectors  (NO trailing slash)
      register: (s) => registerSectorsRoutes(s, "/api/sectors"),
    },
    {
      name: "Sector assets",
      // Parametric route: /api/sectors/:sector
      register: (s) => registerSectorAssetsRoutes(s, "/api/sectors"),
      optional: true,
    },
    { name: "Stocks",        register: (s) => registerStocksRoutes(s, "/api/stocks") },
    { name: "Price history", register: (s) => registerPriceHistoryRoutes(s, "/api/prices"), optional: true },
    { name: "Market-cap series", register: (s) => registerMcapRoutes(s, "/api/mcap-series"), optional: true },
    { name: "Quarterly",     register: (s) => registerQuarterlyRoutes(s, "/api/quarterly"), optional: true },
    { name: "Earnings",      register: (s) => registerEarningsRoutes(s, "/api/earnings"), optional: true },
    { name: "Order book",    register: (s) => registerOrderBookRoutes(s, "/api/orderbook"), optional: true },
    { name: "Sales trends",  register: (s) => registerSalesTrendsRoutes(s, "/api/sales-trends"), optional: true },
    { name: "Rankings",      register: (s) => registerRankingsRoutes(s, { prefix: "/api/rankings" }), optional: true },
    { name: "Suggestions",   register: (s) => registerSuggestionsRoutes(s, "/api/suggestions"), optional: true },

    // ── Auth / user-facing ──
    { name: "Auth",          register: (s) => registerAuthRoutes(s, "/api/auth") },
    { name: "Tickets",       register: (s) => registerTicketsRoutes(s, "/api/tickets"), optional: true },

    // ── Admin / ingest (should be required in prod) ──
    {
      name: "Admin",
      register: (s) => registerAdminRoutes(s),
      optional: !isProd,
    },
    {
      name: "Admin ingest (localhost only)",
      register: (s) => registerIngestRoutes(s),
      optional: !isProd,
    },
  ];

  // Root info endpoint — registered BEFORE the loop so a failed
  // registrar can't leave the server without a liveness endpoint.
  server.get("/", async () => ({
    name: "Bourse Radar API",
    version: process.env.npm_package_version ?? "0.1.0",
    status: "ok",
  }));

  for (const route of routes) {
    try {
      await route.register(server);
      server.log.info({ route: route.name }, "routes registered");
    } catch (e) {
      server.log.error(
        { err: e, route: route.name, optional: !!route.optional },
        "route registration failed",
      );
      // In production, ANY failure is a bug and we refuse to boot.
      // In dev, only optional routes are tolerated.
      if (isProd || !route.optional) throw e;
    }
  }

  server.log.info("all routes registered");
}