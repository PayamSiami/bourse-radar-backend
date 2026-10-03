import type { FastifyInstance } from "fastify";
import { getOrSet } from "#utils/cache";

// ─── Types ──────────────────────────────────────────────

interface SectorAssetRow {
  symbol: string;
  name: string;
  market_cap: number | null;
  forward_pe: number | null;
  dps: number | null;
  eps: number | null;
  eps_growth: number | null;
  net_margin: number | null;
  sales_growth_mom: number | null;
  sales_growth_ytd: number | null;
  return_1y: number | null;
  last_price: number | null;
}

// ─── Swagger Schemas ────────────────────────────────────

const SectorAssetSchema = {
  type: "object",
  properties: {
    symbol: { type: "string" },
    name: { type: "string" },
    market_cap: { type: ["number", "null"], description: "Market cap (billion IRR)" },
    forward_pe: { type: ["number", "null"] },
    dps: { type: ["number", "null"], description: "Not yet available" },
    eps: { type: ["number", "null"] },
    eps_growth: { type: ["number", "null"], description: "Not yet available" },
    net_margin: { type: ["number", "null"] },
    sales_growth_mom: { type: ["number", "null"] },
    sales_growth_ytd: { type: ["number", "null"] },
    return_1y: { type: ["number", "null"], description: "Not yet available" },
    last_price: { type: ["number", "null"] },
  },
} as const;

const SectorAssetsResponseSchema = {
  type: "object",
  properties: {
    sector: { type: "string" },
    data: { type: "array", items: SectorAssetSchema },
    meta: {
      type: "object",
      properties: {
        total: { type: "number" },
        generatedAt: { type: "string" },
      },
    },
  },
} as const;

// ─── Route ──────────────────────────────────────────────

export async function registerSectorAssetsRoutes(
  server: FastifyInstance,
  prefix: string,
) {
  server.get(
    `${prefix}/:sector`,
    {
      schema: {
        tags: ["sectors"],
        summary: "List stocks in a sector with fundamental metrics",
        description:
          "Returns all stocks in a sector with forward P/E, EPS, net margin, " +
          "monthly & cumulative sales growth. Sorted by market cap (desc).",
        params: {
          type: "object",
          properties: {
            sector: { type: "string", description: "URL-encoded sector name" },
          },
        },
        response: { 200: SectorAssetsResponseSchema },
      },
    },
    async (req, reply) => {
      const { sector } = req.params as { sector: string };
      const sectorName = decodeURIComponent(sector);
      // 90s per-sector entry — balances freshness (mcap changes live)
      // against avoiding 5 CTEs + two lateral joins on every click.
      const { data, hit } = await getOrSet(
        server,
        `sector-assets:${sectorName}`,
        90,
        async () => {
          // Get previous month for MoM calc
          const months = await server.db<{ month_end: Date }[]>`
        SELECT DISTINCT month_end
        FROM monthly_sales
        ORDER BY month_end DESC
        LIMIT 2
      `;

      const previous = months[1]?.month_end ?? null;

      const rows = await server.db<SectorAssetRow[]>`
        WITH latest_fp AS (
          SELECT DISTINCT ON (symbol)
            symbol,
            forward_pe,
            estimated_annual_eps,
            margin_used,
            confidence
          FROM forward_pe
          ORDER BY symbol, calculated_at DESC
        ),
        latest_quarterly AS (
          SELECT DISTINCT ON (symbol)
            symbol,
            net_margin,
            revenue,
            net_profit,
            period_end
          FROM quarterly_financials
          ORDER BY symbol, period_end DESC
        ),
        latest_price AS (
          SELECT DISTINCT ON (symbol)
            symbol,
            last_price,
            timestamp
          FROM prices
          ORDER BY symbol, timestamp DESC
        ),
        latest_monthly AS (
          SELECT DISTINCT ON (symbol)
            symbol,
            sales_amount AS current_sales,
            month_end AS current_month,
            detail
          FROM monthly_sales
          ORDER BY symbol, month_end DESC
        ),
        prev_monthly AS (
          SELECT DISTINCT ON (symbol)
            symbol,
            sales_amount AS previous_sales
          FROM monthly_sales
          WHERE month_end = ${previous}
          ORDER BY symbol
        )
        SELECT
          s.symbol,
          s.name,
          CASE
            WHEN lp.last_price IS NOT NULL AND s.shares_outstanding IS NOT NULL
            THEN (lp.last_price * s.shares_outstanding / 1e9)::float8
            ELSE NULL
          END AS market_cap,
          lf.forward_pe::float8 AS forward_pe,
          NULL::float8 AS dps,
          lf.estimated_annual_eps::float8 AS eps,
          NULL::float8 AS eps_growth,
          (lq.net_margin * 100)::float8 AS net_margin,
          CASE
            WHEN pm.previous_sales > 0 AND lm.current_sales IS NOT NULL
            THEN (((lm.current_sales - pm.previous_sales)::float8 / pm.previous_sales) * 100)
            ELSE NULL
          END AS sales_growth_mom,
          CASE
            WHEN (lm.detail->>'priorYtdSalesTotal')::numeric > 0
            THEN (
              (((lm.detail->>'ytdSalesTotal')::numeric
                - (lm.detail->>'priorYtdSalesTotal')::numeric)
                / (lm.detail->>'priorYtdSalesTotal')::numeric) * 100
            )::float8
            ELSE NULL
          END AS sales_growth_ytd,
          NULL::float8 AS return_1y,
          lp.last_price::float8 AS last_price
        FROM stocks s
        LEFT JOIN latest_fp        lf ON lf.symbol = s.symbol
        LEFT JOIN latest_quarterly lq ON lq.symbol = s.symbol
        LEFT JOIN latest_price     lp ON lp.symbol = s.symbol
        LEFT JOIN latest_monthly   lm ON lm.symbol = s.symbol
        LEFT JOIN prev_monthly     pm ON pm.symbol = s.symbol
        WHERE s.sector = ${sectorName}
        ORDER BY market_cap DESC NULLS LAST, s.symbol ASC
      `;

          return {
            sector: sectorName,
            data: rows,
            meta: {
              total: rows.length,
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