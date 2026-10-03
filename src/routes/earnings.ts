// backend/src/routes/earnings.ts
import type { FastifyInstance } from "fastify";
import { getOrSet } from "#utils/cache";

export async function registerEarningsRoutes(
  server: FastifyInstance,
  prefix: string,
) {
  server.get(
    `${prefix}/:symbol`,
    {
      schema: {
        tags: ["earnings"],
        summary: "Retained earnings & dividend trend",
        params: {
          type: "object",
          properties: { symbol: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              quarterly: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    period_end: { type: "string" },
                    fiscal_year: { type: "number" },
                    quarter: { type: "number" },
                    label: { type: "string" },
                    eps_rials: { type: ["number", "null"] },
                    net_profit_millions: { type: ["number", "null"] },
                    net_margin: { type: ["number", "null"] },
                    revenue_millions: { type: ["number", "null"] },
                  },
                },
              },
              summary: {
                type: "object",
                properties: {
                  latest_eps: { type: ["number", "null"] },
                  latest_margin: { type: ["number", "null"] },
                  eps_growth_yoy: { type: ["number", "null"] },
                  net_profit_growth_yoy: { type: ["number", "null"] },
                  dividend_per_share: { type: ["number", "null"] },
                  dividend_payout_ratio: { type: ["number", "null"] },
                },
              },
              meta: {
                type: "object",
                properties: {
                  count: { type: "number" },
                  generatedAt: { type: "string" },
                },
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
        `earnings:${sym}`,
        300,
        async () => {
          const rows = await server.db<
        {
          period_end: Date;
          fiscal_year: number;
          quarter: number;
          eps_rials: number | null;
          net_profit: number | null;
          net_margin: number | null;
          revenue: number | null;
        }[]
      >`
        SELECT
          period_end,
          fiscal_year,
          quarter,
          eps_rials::float8 AS eps_rials,
          net_profit::float8 AS net_profit,
          net_margin::float8 AS net_margin,
          revenue::float8 AS revenue
        FROM quarterly_financials
        WHERE symbol = ${sym}
          AND period_end IS NOT NULL
        ORDER BY period_end ASC
      `;

      const quarterly = rows.map((r) => ({
        period_end: r.period_end.toISOString(),
        fiscal_year: r.fiscal_year,
        quarter: r.quarter,
        label: `به ${new Date(r.period_end).toLocaleDateString("fa-IR", {
          year: "numeric",
        })}`,
        eps_rials: r.eps_rials,
        net_profit_millions: r.net_profit,
        net_margin: r.net_margin,
        revenue_millions: r.revenue,
      }));

      const latest = quarterly[quarterly.length - 1];
      const yearAgo =
        quarterly.length >= 5 ? quarterly[quarterly.length - 5] : null;

      const epsGrowthYoy =
        latest?.eps_rials && yearAgo?.eps_rials && yearAgo.eps_rials > 0
          ? ((latest.eps_rials - yearAgo.eps_rials) / yearAgo.eps_rials) * 100
          : null;

      const netProfitGrowthYoy =
        latest?.net_profit_millions &&
        yearAgo?.net_profit_millions &&
        yearAgo.net_profit_millions > 0
          ? ((latest.net_profit_millions - yearAgo.net_profit_millions) /
              yearAgo.net_profit_millions) *
            100
          : null;

          return {
            symbol: sym,
            quarterly,
            summary: {
              latest_eps: latest?.eps_rials ?? null,
              latest_margin: latest?.net_margin ?? null,
              eps_growth_yoy: epsGrowthYoy,
              net_profit_growth_yoy: netProfitGrowthYoy,
              dividend_per_share: null,
              dividend_payout_ratio: null,
            },
            meta: {
              count: quarterly.length,
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