import type { FastifyInstance } from "fastify";
import { getOrSet } from "#utils/cache";

// ─── Types ──────────────────────────────────────────────

interface SectorRow {
  sector: string;
  stock_count: number;
  avg_forward_pe: number | null;
  high_confidence_count: number;
  median_attractiveness: number | null;
  top_symbol: string | null;
}

// ─── Swagger Schemas ────────────────────────────────────

const SectorItemSchema = {
  type: "object",
  properties: {
    sector: { type: "string", description: "Industry group name (TSETMC)" },
    stock_count: { type: "number" },
    avg_forward_pe: { type: ["number", "null"] },
    high_confidence_count: { type: "number" },
    median_attractiveness: { type: ["number", "null"] },
    top_symbol: { type: ["string", "null"] },
  },
} as const;

const SectorsResponseSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: SectorItemSchema },
    meta: {
      type: "object",
      properties: {
        total: { type: "number" },
        totalStocks: { type: "number" },
        generatedAt: { type: "string" },
      },
    },
  },
} as const;

// ─── Route ──────────────────────────────────────────────

export async function registerSectorsRoutes(
  server: FastifyInstance,
  prefix: string,
) {
  server.get(
    `${prefix}/`,
    {
      schema: {
        tags: ["sectors"],
        summary: "List sectors with aggregate stats",
        description:
          "Returns all industry groups from the stocks table with average forward P/E, " +
          "confidence distribution, median attractiveness, and top symbol per sector.",
        response: { 200: SectorsResponseSchema },
      },
    },
    async (req, reply) => {
      // Sectors change only when stocks/forward_pe refresh (daily cron),
      // so a 5-minute shared entry is safe and collapses the homepage's
      // two-request fan-out (rankings + sectors) into zero DB hits on repeat.
      const { data, hit } = await getOrSet(
        server,
        "sectors:list",
        300,
        async () => {
          const rows = await server.db<SectorRow[]>`
        WITH latest_fp AS (
          -- Latest forward_pe row per symbol
          SELECT DISTINCT ON (symbol)
            symbol,
            forward_pe,
            confidence,
            confidence_score
          FROM forward_pe
          ORDER BY symbol, calculated_at DESC
        ),
        -- Materialized view has ONE row per symbol, no timestamp
        ranking AS (
          SELECT symbol, attractiveness_score, "rank"
          FROM stock_rankings
        ),
        sector_stats AS (
          SELECT
            s.sector,
            COUNT(*)::int AS stock_count,
            AVG(lf.forward_pe) FILTER (WHERE lf.forward_pe > 0)::float8 AS avg_forward_pe,
            COUNT(*) FILTER (WHERE lf.confidence = 'high')::int AS high_confidence_count,
            PERCENTILE_CONT(0.5) WITHIN GROUP (
              ORDER BY r.attractiveness_score
            )::float8 AS median_attractiveness
          FROM stocks s
          LEFT JOIN latest_fp lf ON lf.symbol = s.symbol
          LEFT JOIN ranking   r  ON r.symbol  = s.symbol
          WHERE s.sector IS NOT NULL AND s.sector <> ''
          GROUP BY s.sector
        ),
        top_per_sector AS (
          SELECT DISTINCT ON (s.sector)
            s.sector,
            s.symbol AS top_symbol
          FROM stocks s
          JOIN ranking r ON r.symbol = s.symbol
          WHERE s.sector IS NOT NULL AND s.sector <> ''
          ORDER BY s.sector, r.attractiveness_score DESC NULLS LAST
        )
        SELECT
          ss.sector,
          ss.stock_count,
          ss.avg_forward_pe,
          ss.high_confidence_count,
          ss.median_attractiveness,
          tps.top_symbol
        FROM sector_stats ss
        LEFT JOIN top_per_sector tps USING (sector)
        ORDER BY ss.stock_count DESC, ss.sector ASC
      `;

      const totalRows = await server.db<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM stocks
        WHERE sector IS NOT NULL AND sector <> ''
      `;
          const totalStocks = totalRows[0]?.count ?? 0;

          return {
            data: rows,
            meta: {
              total: rows.length,
              totalStocks,
              generatedAt: new Date().toISOString(),
            },
          };
        },
      );

      reply.header("x-cache", hit ? "HIT" : "MISS");
      return reply.send(data);
    },
  );
}
