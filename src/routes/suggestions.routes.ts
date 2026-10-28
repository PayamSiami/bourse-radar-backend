import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LlmNarrator } from "#services/llm";
import {
  buildCacheKey,
  hashMetrics,
  readCache,
  readStaleCache,
  writeCache,
  readNarrative,
  writeNarrative,
  withSingleFlight,
} from "#services/suggestion-cache";

const QuerySchema = z.object({
  top_n: z.coerce.number().int().min(1).max(100).default(20),
  min_confidence: z.enum(["high", "medium", "low"]).default("medium"),
  sector: z.string().optional(),
});

type Params = z.infer<typeof QuerySchema>;

/**
 * حداکثر سنی که پاسخ کهنه هنوز قابل ارائه است (مثلاً ۲۴ ساعت).
 * اگر از این بیشتر گذشت، کاربر منتظر می‌ماند تا داده تازه تولید شود.
 */
const MAX_STALE_MS = 24 * 60 * 60 * 1000;

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

      const cacheKey = buildCacheKey(q.data);

      // ── لایه ۱: کش تازه ────────────────────────────
      const fresh = await readCache<Record<string, unknown>>(server, cacheKey);
      if (fresh) {
        reply.header("x-cache", "fresh");
        return reply.send({ ...fresh, fromCache: true });
      }

      // ── لایه ۲: کش کهنه → فوری + refresh پس‌زمینه ──
      const stale = await readStaleCache<Record<string, unknown>>(
        server,
        cacheKey,
      );

      if (stale) {
        // اگر خیلی قدیمی است، دیگر قابل اعتماد نیست → منتظر بمان
        if (stale.ageMs > MAX_STALE_MS) {
          server.log.warn(
            { cacheKey, ageMs: stale.ageMs },
            "stale cache too old — blocking regenerate",
          );
        } else {
          // فوری بفرست
          reply.header("x-cache", "stale");
          reply.header("x-cache-age-ms", String(stale.ageMs));
          reply.send({
            ...stale.data,
            stale: true,
            ageMs: stale.ageMs,
          });

          // در پس‌زمینه بازسازی کن — کاربر منتظر نمی‌ماند
          void withSingleFlight(cacheKey, () =>
            regenerate(server, cacheKey, q.data),
          ).catch((e) =>
            server.log.warn({ err: e, cacheKey }, "background refresh failed"),
          );

          return;
        }
      }
      const result = await withSingleFlight(cacheKey, () =>
        regenerate(server, cacheKey, q.data),
      );
      reply.header("x-cache", "miss");
      return reply.send(result);
    },
  );
}

// ────────────────────────────────────────────────────────────
// منطق تولید — از DB + LLM
// ────────────────────────────────────────────────────────────
async function regenerate(
  server: FastifyInstance,
  cacheKey: string,
  params: Params,
): Promise<Record<string, unknown>> {
  const t0 = performance.now();

  // confidence levels
  let confLevels: string[];
  switch (params.min_confidence) {
    case "high":
      confLevels = ["high"];
      break;
    case "medium":
      confLevels = ["high", "medium"];
      break;
    default:
      confLevels = ["high", "medium", "low"];
  }

  // ── rows ──────────────────────────────────────────
  const rows = await server.db`
    SELECT
      s.symbol, s.name, s.sector,
      p.last_price, p.volume,
      fp.forward_pe, fp.estimated_annual_eps, fp.confidence,
      fp.confidence_score, fp.disclaimer,
      fp.calculation_json AS "calcDetails",
      fr.attractiveness_score,
      fr."rank" AS "overallRank"
    FROM stock_rankings fr
    JOIN stocks s ON s.symbol = fr.symbol
    LEFT JOIN LATERAL (
      SELECT forward_pe, estimated_annual_eps, confidence, confidence_score,
             disclaimer, calculation_json
      FROM forward_pe WHERE symbol = s.symbol
      ORDER BY calculated_at DESC LIMIT 1
    ) fp ON TRUE
    LEFT JOIN LATERAL (
      SELECT last_price, volume FROM prices WHERE symbol = s.symbol
      ORDER BY timestamp DESC LIMIT 1
    ) p ON TRUE
    WHERE fp.forward_pe IS NOT NULL
      AND fp.forward_pe > 0
      AND fp.confidence <> 'non_calculable'
      AND fp.confidence = ANY(${confLevels})
      ${params.sector ? server.db`AND s.sector = ${params.sector}` : server.db``}
    ORDER BY fr.attractiveness_score DESC
    LIMIT ${params.top_n}
  `;

  if (rows.length === 0) {
    const empty = {
      data: [],
      generatedAt: new Date().toISOString(),
      model: null,
      note: "No stocks meet the specified criteria.",
    };
    await writeCache(server, cacheKey, empty, null, 60);
    return empty;
  }

  // ── sectorAggs (بدون کش فعلاً — بعداً اضافه کن) ──
  const sectorAggs = await server.db`
    SELECT
      s.sector,
      AVG(fp.forward_pe) FILTER (WHERE fp.forward_pe > 0) AS "avgForwardPe",
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fp.confidence_score)
        AS "medianConfidence",
      COUNT(*) AS "sampleSize"
    FROM stocks s
    JOIN LATERAL (
      SELECT forward_pe, confidence, confidence_score FROM forward_pe
      WHERE symbol = s.symbol ORDER BY calculated_at DESC LIMIT 1
    ) fp ON TRUE
    WHERE fp.forward_pe IS NOT NULL
      AND fp.forward_pe > 0
      AND fp.confidence <> 'non_calculable'
    GROUP BY s.sector
  `;

  const sectorMap = new Map(sectorAggs.map((r) => [r.sector, r]));

  // ── LLM ───────────────────────────────────────────
  const narrator = new LlmNarrator();
  const baseModelName: string = narrator.modelName;
  let modelName: string | null = baseModelName;
  let llmError: string | null = null;

  let narratives: unknown[];

  try {
    const looked = await Promise.all(
      rows.map(async (r) => {
        const hash = hashMetrics(r);
        const hit = await readNarrative(server, r.symbol, hash);
        return { row: r, hash, hit };
      }),
    );

    const misses = looked.filter((x) => !x.hit);
    let fresh: unknown[] = [];

    if (misses.length > 0) {
      fresh = await narrator.generateBatch(
        misses.map((m) => m.row),
        sectorMap,
      );

      if (fresh.length !== misses.length) {
        throw new Error(
          `LLM batch returned ${fresh.length} items for ${misses.length} rows`,
        );
      }

      await Promise.all(
        misses.map(async (m, i) => {
          const item = fresh[i] as Record<string, unknown> | undefined;
          if (!item || item["fallback"] === true) return;
          await writeNarrative(
            server,
            m.row.symbol,
            m.hash,
            item,
            baseModelName,
          );
        }),
      );

      const fallbackCount = (fresh as Array<Record<string, unknown>>).filter(
        (x) => x?.["fallback"] === true,
      ).length;
      if (fallbackCount > 0) {
        llmError = `LLM failed for ${fallbackCount}/${misses.length} stocks (partial fallback)`;
      }
    }

    let freshIdx = 0;
    narratives = looked.map((c) => {
      if (c.hit) {
        return { ...(c.hit as object), fromCache: true };
      }

      const value = fresh[freshIdx++] as Record<string, unknown> | undefined;

      if (!value) {
        server.log.warn(
          { symbol: c.row.symbol, freshLen: fresh.length },
          "LLM batch returned undefined slot",
        );
        return {
          symbol: c.row.symbol,
          fallback: true,
          error: "LLM result missing from batch",
          rawData: c.row,
        };
      }

      return { ...value, fromCache: false };
    });
  } catch (e: unknown) {
    llmError = e instanceof Error ? e.message : String(e);
    server.log.warn({ err: e }, "LLM generation failed, using raw fallback");
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
      topN: params.top_n,
      minConfidence: params.min_confidence,
      sectorFilter: params.sector ?? null,
      llmFailed: llmError !== null,
    },
    generatedAt: new Date().toISOString(),
    model: modelName,
  };

  const fullFailure = modelName === null;
  const partialFailure = llmError !== null && !fullFailure;
  const cacheTtl = fullFailure ? 120 : partialFailure ? 300 : undefined;

  await writeCache(server, cacheKey, result, modelName, cacheTtl);

  server.log.info(
    {
      cacheKey,
      timingMs: performance.now() - t0,
      misses: misses_count(narratives),
    },
    "regenerate done",
  );

  return result;
}

function misses_count(narratives: unknown[]): number {
  return narratives.filter(
    (n) => (n as Record<string, unknown>)?.["fromCache"] === false,
  ).length;
}
