import type { FastifyInstance } from "fastify";
import { z } from "zod";

/**
 * GET /api/stocks
 * List all symbols with Forward P/E, confidence, and sector.
 */

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sector: z.string().optional(),
  min_confidence: z
    .enum(["high", "medium", "low", "non_calculable"])
    .optional(),
  has_forward_pe: z.coerce.boolean().optional(),
});

/** Hydrate JSONB columns that the postgres driver returns as raw strings. */
function parseJsonb<T = any>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

/** Map min_confidence to the list of acceptable confidence levels. */
function confidenceLevels(
  min: "high" | "medium" | "low" | "non_calculable" | undefined,
): string[] | null {
  if (!min) return null;
  switch (min) {
    case "high":
      return ["high"];
    case "medium":
      return ["high", "medium"];
    case "low":
      return ["high", "medium", "low"];
    case "non_calculable":
      return ["non_calculable"];
  }
}

export async function registerStocksRoutes(
  server: FastifyInstance,
  prefix: string,
) {
  // GET {prefix}/
  server.get(
    `${prefix}/`,
    {
      schema: {
        tags: ["stocks"],
        description: "List all TSE symbols with Forward P/E and confidence",
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            sector: { type: "string" },
            min_confidence: {
              type: "string",
              enum: ["high", "medium", "low", "non_calculable"],
            },
            has_forward_pe: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      const q = QuerySchema.safeParse(req.query);
      if (!q.success) {
        return reply.status(400).send({ error: q.error.flatten() });
      }

      const offset = (q.data.page - 1) * q.data.limit;
      const confList = confidenceLevels(q.data.min_confidence);

      // Cache
      const cacheKey = `stocks:${JSON.stringify(q.data)}`;
      try {
        const cached = await server.redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Date.now() - parsed._cachedAt < 300_000) {
            return reply.send(parsed.data);
          }
        }
      } catch (e) {
        server.log.warn({ err: e }, "stocks list cache read failed");
      }

      // Query DB — LATERAL ensures exactly one row per symbol per join.
      const rows = await server.db`
        SELECT
          s.symbol, s.name, s.sector,
          s.shares_outstanding,
          p.last_price, p.volume, p."timestamp",
          fp.forward_pe, fp.estimated_annual_eps,
          fp.confidence, fp.confidence_score,
          fp.disclaimer,
          fr.attractiveness_score,
          fr."rank"
        FROM stocks s
        LEFT JOIN LATERAL (
          SELECT last_price, volume, "timestamp"
          FROM prices
          WHERE symbol = s.symbol
          ORDER BY "timestamp" DESC LIMIT 1
        ) p ON TRUE
        LEFT JOIN LATERAL (
          SELECT forward_pe, estimated_annual_eps, confidence, confidence_score,
                 disclaimer, calculated_at
          FROM forward_pe
          WHERE symbol = s.symbol
          ORDER BY calculated_at DESC LIMIT 1
        ) fp ON TRUE
        LEFT JOIN LATERAL (
          SELECT attractiveness_score, "rank"
          FROM stock_rankings
          WHERE symbol = s.symbol
          ORDER BY calculated_at DESC LIMIT 1
        ) fr ON TRUE
        WHERE (${q.data.sector ? server.db`s.sector = ${q.data.sector}` : server.db`TRUE`})
          AND (${q.data.has_forward_pe === true ? server.db`fp.forward_pe IS NOT NULL` : server.db`TRUE`})
          AND (${
            confList
              ? server.db`fp.confidence = ANY(${confList})`
              : server.db`TRUE`
          })
        ORDER BY fr.attractiveness_score DESC NULLS LAST
        LIMIT ${q.data.limit} OFFSET ${offset}
      `;

      const result = {
        data: rows,
        meta: {
          page: q.data.page,
          limit: q.data.limit,
          hasMore: rows.length === q.data.limit,
        },
        cachedAt: new Date().toISOString(),
      };

      try {
        await server.redis.setex(
          cacheKey,
          300,
          JSON.stringify({ data: result, _cachedAt: Date.now() }),
        );
      } catch (e) {
        server.log.warn({ err: e }, "stocks list cache write failed");
      }

      return reply.send(result);
    },
  );

  // GET {prefix}/:symbol
  server.get(
    `${prefix}/:symbol`,
    {
      schema: {
        tags: ["stocks"],
        description: "Detailed data for a single symbol",
        params: {
          type: "object",
          properties: {
            symbol: { type: "string", minLength: 2, maxLength: 10 },
          },
        },
      },
    },
    async (req, reply) => {
      const { symbol } = req.params as { symbol: string };
      const cacheKey = `stock_detail:${symbol.toUpperCase()}`;

      try {
        const cached = await server.redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Date.now() - parsed._cachedAt < 600_000) {
            return reply.send(parsed.data);
          }
        }
      } catch (e) {
        server.log.warn({ err: e }, "stock detail cache read failed");
      }

      const [stockRow, priceRow, peRow, salesRows] = await Promise.all([
        server.db`SELECT * FROM stocks WHERE symbol = ${symbol}`.then(
          (r) => r[0],
        ),
        server.db`
          SELECT * FROM prices WHERE symbol = ${symbol}
          ORDER BY timestamp DESC LIMIT 1
        `.then((r) => r[0]),
        server.db`
          SELECT * FROM forward_pe WHERE symbol = ${symbol}
          ORDER BY calculated_at DESC LIMIT 1
        `.then((r) => r[0]),
        server.db`
          SELECT month_end, sales_amount, is_estimated, source_url, fetched_at, detail
          FROM monthly_sales WHERE symbol = ${symbol}
          ORDER BY month_end DESC LIMIT 6
        `,
      ]);

      if (!stockRow) {
        return reply.status(404).send({ error: `Symbol ${symbol} not found` });
      }

      const result = {
        symbol: stockRow.symbol,
        name: stockRow.name,
        nameEn: stockRow.name_en,
        sector: stockRow.sector,
        isin: stockRow.isin,
        isBank: stockRow.is_bank,
        isInsurance: stockRow.is_insurance,
        isHoldingCompany: stockRow.is_holding_company,
        sharesOutstanding: stockRow.shares_outstanding,
        price: priceRow
          ? {
              last: Number(priceRow.last_price),
              open: Number(priceRow.open_price),
              high: Number(priceRow.high_price),
              low: Number(priceRow.low_price),
              volume: Number(priceRow.volume),
              value: Number(priceRow.value),
              timestamp: priceRow.timestamp,
              isStale:
                Date.now() - new Date(priceRow.timestamp).getTime() > 300_000,
            }
          : null,
        forwardPe: peRow
          ? {
              forwardPe: peRow.forward_pe ? Number(peRow.forward_pe) : null,
              estimatedAnnualEps: peRow.estimated_annual_eps
                ? Number(peRow.estimated_annual_eps)
                : null,
              confidence: peRow.confidence,
              confidenceScore: Number(peRow.confidence_score),
              method: peRow.method,
              sources: parseJsonb<Record<string, unknown>>(
                peRow.calculation_json,
              ),
              disclaimer: peRow.disclaimer,
            }
          : null,
        salesHistory: (salesRows || []).map((r: any) => {
          const d = parseJsonb<any>(r.detail);
          return {
            monthEnd: r.month_end,
            salesAmount: Number(r.sales_amount),
            isEstimated: !!r.is_estimated,
            sourceUrl: r.source_url,
            fetchedAt: r.fetched_at,
            ytdSalesTotal: d ? Number(d.ytdSalesTotal ?? null) : null,
            priorYtdSalesTotal: d ? Number(d.priorYtdSalesTotal ?? null) : null,
            domesticMonthly: d ? Number(d.domesticMonthly ?? null) : null,
            exportMonthly: d ? Number(d.exportMonthly ?? null) : null,
            productCount: d ? (Array.isArray(d.goods) ? d.goods.length : 0) : 0,
            detail: d,
          };
        }),
      };

      try {
        await server.redis.setex(
          cacheKey,
          600,
          JSON.stringify({ data: result, _cachedAt: Date.now() }),
        );
      } catch (e) {
        server.log.warn({ err: e }, "stock detail cache write failed");
      }

      return reply.send(result);
    },
  );
}
