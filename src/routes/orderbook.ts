// backend/src/routes/orderbook.ts
import type { FastifyInstance } from "fastify";

const TSETMC_BASE = "https://cdn.tsetmc.com/api";

/** One price level, shared by the bid and ask sides. */
const levelSchema = {
  type: "object",
  properties: {
    level: { type: "number" },
    price: { type: "number" },
    volume: { type: "number" },
    count: { type: "number" },
  },
} as const;

/** Response body returned for every outcome (200, 404, 502). */
const orderBookSchema = {
  type: "object",
  properties: {
    symbol: { type: "string" },
    insCode: { type: ["string", "null"] },
    bids: { type: "array", items: levelSchema },
    asks: { type: "array", items: levelSchema },
    meta: {
      type: "object",
      properties: {
        fetchedAt: { type: "string" },
        cached: { type: "boolean" },
      },
    },
  },
} as const;

export async function registerOrderBookRoutes(
  server: FastifyInstance,
  prefix: string,
) {
  server.get(
    `${prefix}/:symbol`,
    {
      schema: {
        tags: ["orderbook"],
        summary: "Live order book for a symbol",
        description:
          "Fetches real-time best-limits (5 levels) from TSETMC. " +
          "Cached for 5 seconds to reduce upstream load.",
        params: {
          type: "object",
          properties: { symbol: { type: "string" } },
        },
        response: {
          200: orderBookSchema,
          // Both failure paths return the same shape with an `error` reason,
          // so the client can render bids/asks as empty rather than crashing.
          404: { ...orderBookSchema, properties: { ...orderBookSchema.properties, error: { type: "string" } } },
          502: { ...orderBookSchema, properties: { ...orderBookSchema.properties, error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const { symbol } = req.params as { symbol: string };
      const sym = decodeURIComponent(symbol);

      // 1) Look up insCode from stocks table
      const stock = await server.db<
        { isin: string | null; ins_code: string | null }[]
      >`
        SELECT isin, ins_code FROM stocks WHERE symbol = ${sym} LIMIT 1
      `;
      const row = stock[0];

      if (!row || !row.ins_code) {
        return reply.status(404).send({
          symbol: sym,
          insCode: null,
          bids: [],
          asks: [],
          meta: {
            fetchedAt: new Date().toISOString(),
            cached: false,
          },
          error: "insCode not found — run ingestion first",
        });
      }

      // 2) Fetch from TSETMC with 5-second cache
      const cacheKey = `orderbook:${row.ins_code}`;
      let cached: string | null = null;
      try {
        cached = await server.redis.get(cacheKey);
      } catch {
        /* ignore redis errors */
      }

      if (cached) {
        const parsed = JSON.parse(cached);
        return reply.send({
          ...parsed,
          meta: { ...parsed.meta, cached: true },
        });
      }

      const url = `${TSETMC_BASE}/BestLimits/${row.ins_code}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        return reply.status(502).send({
          symbol: sym,
          insCode: row.ins_code,
          bids: [],
          asks: [],
          meta: {
            fetchedAt: new Date().toISOString(),
            cached: false,
          },
          error: `TSETMC ${res.status}`,
        });
      }

      const json = (await res.json()) as {
        bestLimits?: Array<{
          number: number;
          pMeDem: number;
          qTitMeDem: number;
          zOrdMeDem: number;
          pMeOf: number;
          qTitMeOf: number;
          zOrdMeOf: number;
        }>;
      };

      const bids: Array<{
        level: number;
        price: number;
        volume: number;
        count: number;
      }> = [];
      const asks: Array<{
        level: number;
        price: number;
        volume: number;
        count: number;
      }> = [];

      for (const l of json.bestLimits ?? []) {
        if (l.pMeDem > 0 && l.qTitMeDem > 0) {
          bids.push({
            level: l.number,
            price: l.pMeDem,
            volume: l.qTitMeDem,
            count: l.zOrdMeDem,
          });
        }
        if (l.pMeOf > 0 && l.qTitMeOf > 0) {
          asks.push({
            level: l.number,
            price: l.pMeOf,
            volume: l.qTitMeOf,
            count: l.zOrdMeOf,
          });
        }
      }

      const response = {
        symbol: sym,
        insCode: row.ins_code,
        bids,
        asks,
        meta: {
          fetchedAt: new Date().toISOString(),
          cached: false,
        },
      };

      try {
        await server.redis.setex(cacheKey, 5, JSON.stringify(response));
      } catch {
        /* ignore */
      }

      return reply.send(response);
    },
  );
}
