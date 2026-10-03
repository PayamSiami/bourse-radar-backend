import type { FastifyInstance } from "fastify";
import { getOrSet } from "#utils/cache";

interface MomRow {
  symbol: string;
  name: string;
  sector: string;
  current_sales: number;
  previous_sales: number;
  change_percent: number | null;
}

interface CumulativeRow {
  symbol: string;
  name: string;
  sector: string;
  ytd_sales: number | null;
  prior_ytd_sales: number | null;
  growth_percent: number | null;
}

export async function registerSalesTrendsRoutes(
  server: FastifyInstance,
  prefix: string,
) {
  server.get(
    `${prefix}/`,
    {
      schema: {
        tags: ["sales-trends"],
        summary: "Monthly sales trends",
        description:
          "Top gainers/losers (MoM) and cumulative growth (from Codal YTD when available, otherwise 12-month rolling).",
      },
    },
    async (req, reply) => {
      // Trends only change when monthly_sales is ingested (daily at 14:00),
      // so a 10-minute shared entry is both safe and measurably faster —
      // the cumulative query alone fans out to ~4 CTEs.
      const { data, hit } = await getOrSet(
        server,
        "sales-trends:list",
        600,
        async () => {
          // 1) Two most recent months
          const months = await server.db<{ month_end: Date }[]>`
        SELECT DISTINCT month_end
        FROM monthly_sales
        ORDER BY month_end DESC
        LIMIT 2
      `;

      if (months.length < 2) {
        return {
          gainers: [],
          losers: [],
          cumulative: [],
          meta: { message: "Not enough monthly data" },
        };
      }

      const latest = months[0]!.month_end;
      const previous = months[1]!.month_end;

      // 2) MoM gainers / losers
      const momRows = await server.db<MomRow[]>`
        WITH cur AS (
          SELECT symbol, sales_amount FROM monthly_sales WHERE month_end = ${latest}
        ),
        prev AS (
          SELECT symbol, sales_amount FROM monthly_sales WHERE month_end = ${previous}
        )
        SELECT
          s.symbol, s.name, s.sector,
          cur.sales_amount::float8 AS current_sales,
          prev.sales_amount::float8 AS previous_sales,
          CASE
            WHEN prev.sales_amount > 0
            THEN ((cur.sales_amount - prev.sales_amount)::float8 / prev.sales_amount) * 100
            ELSE NULL
          END AS change_percent
        FROM cur
        JOIN prev USING (symbol)
        JOIN stocks s USING (symbol)
        WHERE prev.sales_amount > 0
      `;

      const validMom = momRows.filter((r) => r.change_percent !== null);

      const gainers = [...validMom]
        .sort((a, b) => Number(b.change_percent) - Number(a.change_percent))
        .slice(0, 5);

      const losers = [...validMom]
        .sort((a, b) => Number(a.change_percent) - Number(b.change_percent))
        .slice(0, 5);

      // 3) Cumulative — prefer detail (real YTD), fall back to 12m rolling
      const cumulative = await server.db<CumulativeRow[]>`
        WITH latest AS (
          SELECT MAX(month_end) AS m FROM monthly_sales
        ),

        -- Prefer latest row per symbol that has both YTD fields
        latest_with_ytd AS (
          SELECT DISTINCT ON (symbol)
            symbol,
            month_end,
            detail
          FROM monthly_sales
          WHERE detail->>'ytdSalesTotal' IS NOT NULL
            AND detail->>'priorYtdSalesTotal' IS NOT NULL
            AND (detail->>'priorYtdSalesTotal')::numeric > 0
          ORDER BY symbol, month_end DESC
        ),

        -- Path A: from Codal detail (real YTD growth)
        from_detail AS (
          SELECT
            lw.symbol,
            s.name,
            s.sector,
            (lw.detail->>'ytdSalesTotal')::float8 AS ytd_sales,
            (lw.detail->>'priorYtdSalesTotal')::float8 AS prior_ytd_sales,
            (
              ((lw.detail->>'ytdSalesTotal')::numeric
                - (lw.detail->>'priorYtdSalesTotal')::numeric)
              / (lw.detail->>'priorYtdSalesTotal')::numeric
            ) * 100 AS growth_percent
          FROM latest_with_ytd lw
          JOIN stocks s USING (symbol)
        ),

        -- Path B: 12m rolling fallback
        current_12m AS (
          SELECT symbol, SUM(sales_amount)::float8 AS total
          FROM monthly_sales
          WHERE month_end > (SELECT m FROM latest) - INTERVAL '12 months'
          GROUP BY symbol
        ),
        prior_12m AS (
          SELECT symbol, SUM(sales_amount)::float8 AS total
          FROM monthly_sales
          WHERE month_end > (SELECT m FROM latest) - INTERVAL '24 months'
            AND month_end <= (SELECT m FROM latest) - INTERVAL '12 months'
          GROUP BY symbol
        ),
        from_12m AS (
          SELECT
            c.symbol,
            s.name,
            s.sector,
            c.total AS ytd_sales,
            p.total AS prior_ytd_sales,
            CASE
              WHEN p.total > 0 THEN ((c.total - p.total) / p.total) * 100
              ELSE NULL
            END AS growth_percent
          FROM current_12m c
          LEFT JOIN prior_12m p USING (symbol)
          JOIN stocks s USING (symbol)
          WHERE c.total > 0
        )

        SELECT * FROM (
          SELECT * FROM from_detail
          ORDER BY growth_percent DESC NULLS LAST
          LIMIT 5
        ) a
        UNION ALL
        SELECT * FROM (
          SELECT * FROM from_12m
          ORDER BY
            CASE WHEN prior_ytd_sales > 0
                 THEN growth_percent
                 ELSE NULL
            END DESC NULLS LAST,
            ytd_sales DESC
          LIMIT 5
        ) b
        WHERE NOT EXISTS (SELECT 1 FROM from_detail LIMIT 1)
        LIMIT 5
      `;

          return {
            gainers,
            losers,
            cumulative,
            meta: {
              latestMonth: latest.toISOString(),
              previousMonth: previous.toISOString(),
              generatedAt: new Date().toISOString(),
              mode: "detail_first_then_12m",
            },
          };
        },
      );

      reply.header("x-cache", hit ? "HIT" : "MISS");
      return reply.send(data);
    },
  );
}