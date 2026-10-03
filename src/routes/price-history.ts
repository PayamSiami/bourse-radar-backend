import type { FastifyInstance } from "fastify";
import { getOrSet } from "#utils/cache";

export async function registerPriceHistoryRoutes(
  server: FastifyInstance,
  prefix: string,
) {
  // GET /api/prices/:symbol — line chart
  server.get(
    `${prefix}/:symbol`,
    {
      schema: {
        tags: ["prices"],
        summary: "Get price history for a symbol",
        params: {
          type: "object",
          properties: { symbol: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            days: { type: "integer", minimum: 1, maximum: 1000, default: 90 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              points: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    t: { type: "string" },
                    p: { type: "number" },
                  },
                },
              },
              meta: {
                type: "object",
                properties: {
                  count: { type: "number" },
                  from: { type: ["string", "null"] },
                  to: { type: ["string", "null"] },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { symbol } = req.params as { symbol: string };
      const { days = 90 } = req.query as { days?: number };
      const sym = decodeURIComponent(symbol);

      const { data, hit } = await getOrSet(
        server,
        `price-history:${sym}:days=${days}`,
        60,
        async () => {
          const points = await server.db<{ t: Date; p: number }[]>`
            SELECT timestamp AS t, last_price::float8 AS p
            FROM prices
            WHERE symbol = ${sym}
              AND timestamp > NOW() - (${days} || ' days')::interval
              AND last_price IS NOT NULL
            ORDER BY timestamp ASC
          `;

          return {
            symbol: sym,
            points,
            meta: {
              count: points.length,
              from: points[0]?.t?.toISOString() ?? null,
              to: points[points.length - 1]?.t?.toISOString() ?? null,
            },
          };
        },
      );

      reply.header("x-cache", hit ? "HIT" : "MISS");
      return reply.send(data);
    },
  );

  // GET /api/prices/:symbol/monthly-chart — bar chart of 3 fiscal years' monthly sales
  server.get(
    `${prefix}/:symbol/monthly-chart`,
    {
      schema: {
        tags: ["prices"],
        summary: "Get monthly sales chart data (3 years)",
        params: {
          type: "object",
          properties: { symbol: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              years: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    jy: { type: "number" },
                    values: {
                      type: "array",
                      items: { type: ["number", "null"] },
                    },
                    ytdTotal: { type: ["number", "null"] },
                    priorYtdTotal: { type: ["number", "null"] },
                  },
                },
              },
              months: {
                type: "array",
                items: { type: "string" },
              },
              meta: {
                type: "object",
                properties: { count: { type: "number" } },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { symbol } = req.params as { symbol: string };
      const sym = decodeURIComponent(symbol);

      const { data, hit } = await getOrSet(
        server,
        `monthly-chart:${sym}`,
        300,
        async () => {
          // Get all monthly sales for this symbol, grouped by Jalali year
          // We use sales_amount and derive Jalali year from month_end via a
          const rows = await server.db<
        {
          month_end: Date;
          sales_amount: number;
          sales_usd: number | null;
          period_jy: number;
          period_jm: number;
          ytd_sales_total: number | null;
          prior_ytd_sales_total: number | null;
          fx_quality: string | null;
        }[]
      >`
        SELECT
          month_end,
          sales_amount::float8 AS sales_amount,
          sales_usd::float8 AS sales_usd,
          (detail->'periodEnd'->>'jy')::int AS period_jy,
          (detail->'periodEnd'->>'jm')::int AS period_jm,
          (detail->>'ytdSalesTotal')::float8 AS ytd_sales_total,
          (detail->>'priorYtdSalesTotal')::float8 AS prior_ytd_sales_total,
          fx_quality
        FROM monthly_sales
        WHERE symbol = ${sym}
          AND detail IS NOT NULL
        ORDER BY month_end ASC
      `;

      // Group by Jalali year (now correctly extracted from detail JSON)
      const byYearRial = new Map<number, (number | null)[]>();
      const byYearUsd = new Map<number, (number | null)[]>();
      const byYearYtd = new Map<number, number>();
      const byYearPrior = new Map<number, number>();

      const maxJy = Math.max(...rows.map((r) => r.period_jy), 0);
      const yearsToShow = [maxJy - 2, maxJy - 1, maxJy].filter((y) => y > 0);

      for (const y of yearsToShow) {
        byYearRial.set(y, Array(12).fill(null));
        byYearUsd.set(y, Array(12).fill(null));
        byYearYtd.set(y, 0);
        byYearPrior.set(y, 0);
      }

      for (const r of rows) {
        const jy = r.period_jy;
        const jm = (r.period_jm ?? 1) - 1; // Jalali month → 0-indexed array slot

        const arrR = byYearRial.get(jy);
        const arrU = byYearUsd.get(jy);
        if (!arrR || !arrU) continue;
        arrR[jm] = r.sales_amount;
        arrU[jm] = r.sales_usd;

        const ytd = r.ytd_sales_total ?? 0;
        byYearYtd.set(jy, (byYearYtd.get(jy) ?? 0) + Math.max(ytd ?? 0, 0));
        byYearPrior.set(jy, (byYearPrior.get(jy) ?? 0) + Math.max(r.prior_ytd_sales_total ?? 0, 0));
      }

      const years = yearsToShow.map((jy) => ({
        jy,
        values: byYearRial.get(jy) ?? Array(12).fill(null),
        valuesUsd: byYearUsd.get(jy) ?? Array(12).fill(null),
        ytdTotal: byYearYtd.get(jy) ?? 0,
        priorYtdTotal: byYearPrior.get(jy - 1) ?? 0,
        fxQuality: rows.find((r) => r.period_jy === jy)?.fx_quality ?? "fallback",
      }));

          return {
            symbol: sym,
            years,
            months: [
              "فروردین",
              "اردیبهشت",
              "خرداد",
              "تیر",
              "مرداد",
              "شهریور",
              "مهر",
              "آبان",
              "آذر",
              "دی",
              "بهمن",
              "اسفند",
            ],
            meta: { count: rows.length },
          };
        },
      );

      reply.header("x-cache", hit ? "HIT" : "MISS");
      return reply.send(data);
    },
  );
}