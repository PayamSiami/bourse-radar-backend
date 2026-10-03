import type { FastifyInstance } from "fastify";
import { z } from "zod";

// ---------- Schemas ----------

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  min_confidence: z.enum(["high", "medium", "low"]).optional(),
  max_forward_pe: z.coerce.number().positive().optional(),
  min_attractiveness: z.coerce.number().min(0).max(100).optional(),
  sector: z.string().optional(),
  refresh: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .optional(),
});

type QueryInput = z.infer<typeof QuerySchema>;

// ---------- Cache helpers (use shared helper v1: prefix) ----------
import { getOrSet } from "#utils/cache";
const CACHE_TTL_SECONDS = 900;

// ---------- Confidence mapping ----------

const CONFIDENCE_LEVELS: Record<
  NonNullable<QueryInput["min_confidence"]>,
  string[]
> = {
  high: ["high"],
  medium: ["high", "medium"],
  low: ["high", "medium", "low"],
};

// ---------- Routes ----------

export async function registerRankingsRoutes(
  server: FastifyInstance,
  opts: { prefix: string },
) {
  const base = opts.prefix.replace(/\/$/, "");

  // GET {prefix}/
  server.get(
    `${base}/`,
    {
      schema: {
        tags: ["rankings"],
        description: "Ranked list of stocks by quantitative attractiveness",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            min_confidence: { type: "string", enum: ["high", "medium", "low"] },
            max_forward_pe: { type: "number", exclusiveMinimum: 0 },
            min_attractiveness: { type: "number", minimum: 0, maximum: 100 },
            sector: { type: "string" },
            refresh: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const q = parsed.data;

      // Build SQL + params BEFORE the cache probe — the compute closure
      // references them, so they must exist (no TDZ) when the probe runs.
      const filters: string[] = [
        `fp.forward_pe IS NOT NULL`,
        `fp.forward_pe > 0`,
        `fp.confidence != 'non_calculable'`,
      ];
      const params: unknown[] = [];

      if (q.min_confidence) {
        const validConfs = CONFIDENCE_LEVELS[q.min_confidence];
        params.push(validConfs);
        filters.push(`fp.confidence = ANY($${params.length}::text[])`);
      }

      if (q.max_forward_pe !== undefined) {
        params.push(q.max_forward_pe);
        filters.push(`fp.forward_pe <= $${params.length}`);
      }

      if (q.min_attractiveness !== undefined) {
        params.push(q.min_attractiveness);
        filters.push(`fr.attractiveness_score >= $${params.length}`);
      } else {
        filters.push(`fr.attractiveness_score IS NOT NULL`);
      }

      if (q.sector) {
        params.push(q.sector);
        filters.push(`s.sector = $${params.length}`);
      }

      const limitPlaceholder = `$${params.length + 1}`;
      const sql = `
        SELECT
          s.symbol,
          s.name,
          s.sector,
          p.last_price        AS "currentPrice",
          p.volume            AS "dailyVolume",
          fp.forward_pe       AS "forwardPe",
          fp.estimated_annual_eps AS "estimatedAnnualEps",
          fp.confidence,
          fp.confidence_score AS "confidenceScore",
          fr.attractiveness_score AS "attractivenessScore",
          fr."rank"           AS "rank",
          p.change_percent    AS "priceChangePercent"
        FROM stock_rankings fr
        JOIN stocks s ON s.symbol = fr.symbol
        LEFT JOIN LATERAL (
          SELECT
            forward_pe, estimated_annual_eps,
            confidence, confidence_score
          FROM forward_pe
          WHERE symbol = s.symbol
          ORDER BY calculated_at DESC
          LIMIT 1
        ) fp ON TRUE
        LEFT JOIN LATERAL (
          SELECT last_price, volume, change_percent
          FROM prices
          WHERE symbol = s.symbol
          ORDER BY timestamp DESC
          LIMIT 1
        ) p ON TRUE
        WHERE ${filters.join(" AND ")}
        ORDER BY fr.attractiveness_score DESC
        LIMIT ${limitPlaceholder} OFFSET 0
      `;

      const cacheKey = `rankings:${JSON.stringify(q)}`;

      if (!q.refresh) {
        const { data, hit } = await getOrSet(
          server,
          cacheKey,
          CACHE_TTL_SECONDS,
          async () => {
            const rowsInner = await server.db.unsafe(
              sql,
              [...params, q.limit] as never[],
            );
            return {
              data: rowsInner,
              meta: {
                count: rowsInner.length,
                filters: q,
                generatedAt: new Date().toISOString(),
                source: "materialized_view" as const,
              },
            };
          },
        );
        reply.header("x-cache", hit ? "HIT" : "MISS");
        return data;
      }

      // refresh=true → bypass cache and run the query directly.
      const rows = await server.db.unsafe(sql, [...params, q.limit] as never[]);
      const result = {
        data: rows,
        meta: {
          count: rows.length,
          filters: q,
          generatedAt: new Date().toISOString(),
          source: "materialized_view" as const,
        },
      };
      // Warm the shared entry for the next reader (best-effort, fail-open).
      getOrSet(server, cacheKey, CACHE_TTL_SECONDS, async () => result).catch(() => {});
      reply.header("x-cache", "MISS");
      return result;
    },
  );

  // GET {prefix}/sectors
  server.get(
    `${base}/sectors`,
    {
      schema: {
        tags: ["rankings"],
        description: "Rankings broken down by sector",
      },
    },
    async (req, reply) => {
      const cacheKey = "rankings:sectors";
      const { data, hit } = await getOrSet(
        server,
        cacheKey,
        CACHE_TTL_SECONDS,
        async () => {
          const rowsInner = await server.db`
        SELECT
          s.sector,
          COUNT(*)                          AS "stock_count",
          AVG(fp.forward_pe)                AS "avg_forward_pe",
          AVG(fp.confidence_score)          AS "avg_confidence",
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fp.forward_pe) AS "median_forward_pe",
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fr.attractiveness_score) AS "median_score"
        FROM stocks s
        JOIN stock_rankings fr ON fr.symbol = s.symbol
        JOIN LATERAL (
          SELECT
            forward_pe, confidence, confidence_score
          FROM forward_pe
          WHERE symbol = s.symbol
          ORDER BY calculated_at DESC
          LIMIT 1
        ) fp ON TRUE
        WHERE fp.confidence != 'non_calculable'
          AND fp.forward_pe IS NOT NULL
          AND fp.forward_pe > 0
        GROUP BY s.sector
        ORDER BY AVG(fr.attractiveness_score) DESC
      `;
          return {
            data: rowsInner,
            generatedAt: new Date().toISOString(),
          };
        },
      );
      if (hit) {
        reply.header("x-cache", "HIT");
        return data;
      }
      // Fall through to compute — handled by getOrSet above? Actually we already computed via getOrSet.
      // getOrSet returned MISS with fresh data, so return it.
      reply.header("x-cache", "MISS");
      return data;
    },
  );
}
