import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LlmNarrator } from "#services/llm";

const QuerySchema = z.object({
  top_n: z.coerce.number().int().min(1).max(100).default(20),
  min_confidence: z.enum(["high", "medium", "low"]).default("medium"),
  sector: z.string().optional(),
});

const CACHE_TTL_SECONDS = 600;
const CACHE_STALE_MS = 600_000;

export async function registerSuggestionsRoutes(
  server: FastifyInstance,
  prefix: string,
) {
  server.get(
    `${prefix}/`,
    {
      schema: {
        tags: ["suggestions"],
        description:
          "LLM-generated Persian analytical narratives for top-ranked stocks " +
          "(NOT investment advice — only explains WHY based on quantitative metrics)",
        querystring: {
          type: "object",
          properties: {
            top_n: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            min_confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
              default: "medium",
            },
            sector: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const q = QuerySchema.safeParse(req.query);
      if (!q.success) {
        return reply.status(400).send({ error: q.error.flatten() });
      }

      // ── Cache lookup ────────────────────────────────
      const cacheKey = `suggestions:${JSON.stringify(q.data)}`;
      try {
        const cached = await server.redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Date.now() - parsed._cachedAt < CACHE_STALE_MS) {
            return reply.send({ ...parsed.data, fromCache: true });
          }
        }
      } catch (e) {
        server.log.warn({ err: e }, "suggestions cache read failed");
      }

      // ── Confidence filter ───────────────────────────
      let confLevels: string[];
      switch (q.data.min_confidence) {
        case "high":
          confLevels = ["high"];
          break;
        case "medium":
          confLevels = ["high", "medium"];
          break;
        default:
          confLevels = ["high", "medium", "low"];
      }

      // ── Top-N ranked stocks (one forward_pe row per symbol) ──
      const rows = await server.db`
        SELECT
          s.symbol,
          s.name,
          s.sector,
          p.last_price,
          p.volume,
          fp.forward_pe,
          fp.estimated_annual_eps,
          fp.confidence,
          fp.confidence_score,
          fp.disclaimer,
          fp.calculation_json AS "calcDetails",
          fr.attractiveness_score,
          fr."rank" AS "overallRank"
        FROM stock_rankings fr
        JOIN stocks s ON s.symbol = fr.symbol
        LEFT JOIN LATERAL (
          SELECT
            forward_pe, estimated_annual_eps, confidence, confidence_score,
            disclaimer, calculation_json
          FROM forward_pe
          WHERE symbol = s.symbol
          ORDER BY calculated_at DESC
          LIMIT 1
        ) fp ON TRUE
        LEFT JOIN LATERAL (
          SELECT last_price, volume
          FROM prices
          WHERE symbol = s.symbol
          ORDER BY timestamp DESC
          LIMIT 1
        ) p ON TRUE
        WHERE fp.forward_pe IS NOT NULL
          AND fp.forward_pe > 0
          AND fp.confidence <> 'non_calculable'
          AND fp.confidence = ANY(${confLevels})
          ${q.data.sector ? server.db`AND s.sector = ${q.data.sector}` : server.db``}
        ORDER BY fr.attractiveness_score DESC
        LIMIT ${q.data.top_n}
      `;

      if (rows.length === 0) {
        return reply.send({
          data: [],
          generatedAt: new Date().toISOString(),
          model: null,
          note: "No stocks meet the specified criteria.",
        });
      }

      // ── Sector-level context (one row per sector, only profitable) ──
      const sectorAggs = await server.db`
        SELECT
          s.sector,
          AVG(fp.forward_pe) FILTER (WHERE fp.forward_pe > 0) AS "avgForwardPe",
          PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY fp.confidence_score
          ) AS "medianConfidence",
          COUNT(*) AS "sampleSize"
        FROM stocks s
        JOIN LATERAL (
          SELECT forward_pe, confidence, confidence_score
          FROM forward_pe
          WHERE symbol = s.symbol
          ORDER BY calculated_at DESC
          LIMIT 1
        ) fp ON TRUE
        WHERE fp.forward_pe IS NOT NULL
          AND fp.forward_pe > 0
          AND fp.confidence <> 'non_calculable'
        GROUP BY s.sector
      `;

      const sectorMap = new Map(sectorAggs.map((r) => [r.sector, r]));

      // ── LLM narratives (safe fallback) ──────────────
      const narrator = new LlmNarrator();
      let narratives: unknown[];
      let modelName: string | null = narrator.modelName ?? "Combo";
      let llmError: string | null = null;

      try {
        narratives = await narrator.generateBatch(rows, sectorMap);
      } catch (e: unknown) {
        llmError = e instanceof Error ? e.message : String(e);
        server.log.warn(
          { err: e },
          "LLM generation failed, using raw fallback",
        );

        narratives = rows.map((r) => ({
          symbol: r.symbol,
          fallback: true,
          error: `LLM generation failed: ${llmError}. Raw quantitative rankings provided instead.`,
          rawData: r,
        }));
        modelName = null;
      }

      const result = {
        data: narratives,
        meta: {
          total: rows.length,
          topN: q.data.top_n,
          minConfidence: q.data.min_confidence,
          sectorFilter: q.data.sector ?? null,
          llmFailed: llmError !== null,
        },
        generatedAt: new Date().toISOString(),
        model: modelName,
      };

      // ── Cache write (best-effort) ───────────────────
      try {
        await server.redis.setex(
          cacheKey,
          CACHE_TTL_SECONDS,
          JSON.stringify({ data: result, _cachedAt: Date.now() }),
        );
      } catch (e) {
        server.log.warn({ err: e }, "suggestions cache write failed");
      }

      return reply.send(result);
    },
  );
}
