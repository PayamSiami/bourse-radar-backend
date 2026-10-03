import type { FastifyInstance } from "fastify";
import { registerStocksRoutes } from "#routes/stocks";
import { registerRankingsRoutes } from "#routes/rankings";
import { registerSuggestionsRoutes } from "#routes/suggestions";
import { registerHealthRoute } from "#routes/health";
import { registerSalesTrendsRoutes } from "#routes/sales-trends";
import { registerIngestRoutes } from "#routes/registerIngestRoutes";
import { registerSectorAssetsRoutes } from "#routes/sector-assets";
import { registerSectorsRoutes } from "#routes/sectors";
import { registerPriceHistoryRoutes } from "#routes/price-history";
import { registerQuarterlyRoutes } from "#routes/quarterly";
import { registerEarningsRoutes } from "#routes/earnings";
import { registerMcapRoutes } from "#routes/mcap-series";
import { registerOrderBookRoutes } from "#routes/orderbook";

type RouteRegistrar = (server: FastifyInstance) => void | Promise<void>;

interface RouteDefinition {
  name: string;
  register: RouteRegistrar;
  /** When true, a failure will be logged but not thrown. */
  optional?: boolean;
}

export async function registerRoutes(server: FastifyInstance) {
  console.log("→ Registering routes");

  const routes: RouteDefinition[] = [
    {
      name: "Health",
      register: (s) => registerHealthRoute(s),
    },
    {
      name: "Stocks",
      register: (s) => registerStocksRoutes(s, "/api/stocks"),
    },
    {
      name: "Rankings",
      register: (s) => registerRankingsRoutes(s, { prefix: "/api/rankings" }),
      optional: true,
    },
    {
      name: "Sales trends",
      register: (s) => registerSalesTrendsRoutes(s, "/api/sales-trends"),
      optional: true,
    },
    {
      name: "Suggestions",
      register: (s) => registerSuggestionsRoutes(s, "/api/suggestions"),
      optional: true,
    },
    {
      name: "Admin ingest (localhost only)",
      register: (s) => registerIngestRoutes(s),
      optional: true,
    },
    {
      name: "Sector assets",
      register: (s) => registerSectorAssetsRoutes(s, "/api/sectors"),
      optional: true,
    },
    {
      name: "Sectors",
      register: (s) => registerSectorsRoutes(s, "/api/sectors"),
      optional: true,
    },
    {
      name: "Price history",
      register: (s) => registerPriceHistoryRoutes(s, "/api/prices"),
      optional: true,
    },
    {
      name: "Market-cap series",
      register: (s) => registerMcapRoutes(s, "/api/mcap-series"),
      optional: true,
    },
    {
      name: "Quarterly",
      register: (s) => registerQuarterlyRoutes(s, "/api/quarterly"),
      optional: true,
    },
    {
      name: "Earnings",
      register: (s) => registerEarningsRoutes(s, "/api/earnings"),
      optional: true,
    },
    {
      name: "Order book",
      register: (s) => registerOrderBookRoutes(s, "/api/orderbook"),
      optional: true,
    },
  ];

  for (const route of routes) {
    try {
      await route.register(server);
      console.log(`  ✓ ${route.name} routes registered`);
    } catch (e) {
      console.error(`  ✗ ${route.name} routes failed:`, e);
      if (!route.optional) throw e;
    }
  }

  server.get("/", async () => ({
    name: "Bourse Radar API",
    version: "0.1.0",
    status: "ok",
  }));

  console.log("✓ Routes registered");
}
