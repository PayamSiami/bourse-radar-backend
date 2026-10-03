import type { FastifyInstance } from "fastify";
import { getOrSet } from "#utils/cache";

export async function registerQuarterlyRoutes(
  server: FastifyInstance,
  prefix: string,
) {
  server.get(
    `${prefix}/:symbol/history`,
    {
      schema: {
        tags: ["quarterly"],
        summary: "Get quarterly EPS/net-margin history for charting",
        params: {
          type: "object",
          properties: { symbol: { type: "string" } },
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
                    label: { type: "string" },
                    pe: { type: ["number", "null"] },
                    period_end: { type: "string" },
                  },
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
        `quarterly:${sym}`,
        300,
        async () => {
          // Get the last N quarterly_financials for this symbol
          const rows = await server.db<
        {
          period_end: Date;
          net_margin: number | null;
          eps_rials: number | null;
        }[]
      >`
        SELECT period_end, net_margin, eps_rials
        FROM quarterly_financials
        WHERE symbol = ${sym}
        ORDER BY period_end ASC
        LIMIT 12
      `;

      // Get current price to compute P/E per quarter
      const priceRow = await server.db<{ last_price: number }[]>`
        SELECT last_price::float8 AS last_price
        FROM prices
        WHERE symbol = ${sym}
        ORDER BY timestamp DESC
        LIMIT 1
      `;
      const currentPrice = priceRow[0]?.last_price ?? null;

      const points = rows.map((r) => {
        const pe =
          r.eps_rials && r.eps_rials > 0 && currentPrice
            ? currentPrice / r.eps_rials
            : null;
        const label = new Date(r.period_end).toLocaleDateString("fa-IR", {
          year: "numeric",
        });
        return {
          label: `به ${label}`,
          pe,
          period_end: r.period_end.toISOString(),
        };
      });

          return { symbol: sym, points };
        },
      );

      reply.header("x-cache", hit ? "HIT" : "MISS");
      return reply.send(data);
    },
  );
}
