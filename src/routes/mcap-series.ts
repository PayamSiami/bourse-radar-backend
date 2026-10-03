import type { FastifyInstance } from "fastify";
import { dateToJalali } from "#utils/jalali";
import { getOrSet } from "#utils/cache";

export async function registerMcapRoutes(
  server: FastifyInstance,
  prefix: string,
) {
  // GET /api/mcap-series/:symbol?days=N
  server.get(
    `${prefix}/:symbol`,
    {
      schema: {
        tags: ["mcap"],
        summary: "Get market-cap series for a symbol (TSETMC prices × shares × FX)",
        params: { type: "object", properties: { symbol: { type: "string" } } },
        querystring: {
          type: "object",
          properties: {
            days: { type: "integer", minimum: 1, maximum: 1855, default: 90 },
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
        `mcap-series:${sym}:days=${days}`,
        60,
        async () => {
          const rows = await server.db<
        Array<{
          date: Date;
          price_rial: number | null;
          shares_count: number | null;
          mcap_rial: number | null;
          mcap_usd: number | null;
          fx_rate_rial: number | null;
          fx_sources: string[] | null;
          fx_quality: string | null;
          source: string;
        }>
      >`
        SELECT date, price_rial, shares_count, mcap_rial, mcap_usd,
               fx_rate_rial, fx_sources, fx_quality, source
        FROM market_cap_history
        WHERE symbol = ${sym}
          AND date >= (NOW() - (${days} || ' days')::interval)::date
        ORDER BY date ASC
      `;

          const stock = await server.db<
            Array<{ name: string; shares_outstanding: string | null }>
          >`
            SELECT name, shares_outstanding FROM stocks WHERE symbol = ${sym}
          `;

          const points = rows.map((r) => {
            const fxRateToman =
              r.fx_rate_rial !== null ? Number(r.fx_rate_rial) / 10 : null;
            return {
              date: r.date.toISOString().split("T")[0],
              priceRial: r.price_rial !== null ? Number(r.price_rial) : null,
              mcapRial: r.mcap_rial !== null ? Number(r.mcap_rial) : null,
              mcapUsd: r.mcap_usd !== null ? Number(r.mcap_usd) : null,
              fxRateToman,
              fxSources: r.fx_sources ?? [],
              fxQualityStatus: r.fx_quality ?? "fallback",
              source: r.source,
            };
          });

          const last = points[points.length - 1];

          return {
            symbol: sym,
            companyName: stock[0]?.name ?? null,
            sharesCount: stock[0]?.shares_outstanding
              ? parseInt(stock[0].shares_outstanding, 10)
              : null,
            points,
            lastTrading: last
              ? {
                date: last.date,
                value: last.mcapRial
                  ? Number((last.mcapRial / 1e10).toFixed(4))
                  : null,
                valueUsd: last.mcapUsd ?? null,
              }
              : null,
            meta: {
              count: points.length,
              from: points[0]?.date ?? null,
              to: last?.date ?? null,
              dataDensity: points.length
                ? days / points.length < 3
                  ? "daily"
                  : days / points.length > 10
                    ? "monthly"
                    : "sparse"
                : "none",
              fxQuality: last?.fxQualityStatus ?? "unknown",
            },
          };
        },
      );

      reply.header("x-cache", hit ? "HIT" : "MISS");
      return reply.send(data);
    },
  );

  // GET /api/mcap-series/:symbol/summary — latest market cap snapshot
  server.get(
    `${prefix}/:symbol/summary`,
    {
      schema: {
        tags: ["mcap"],
        summary: "Get latest market-cap snapshot (current price × shares)",
        params: { type: "object", properties: { symbol: { type: "string" } } },
      },
    },
    async (req, reply) => {
      const { symbol } = req.params as { symbol: string };
      const sym = decodeURIComponent(symbol);

      const { data, hit } = await getOrSet(
        server,
        `mcap-summary:${sym}`,
        60,
        async () => {
          const rows = await server.db<
            Array<{
              date: Date;
              price_rial: number | null;
              shares_count: number | null;
              mcap_rial: number | null;
              mcap_usd: number | null;
              fx_rate_rial: number | null;
              fx_quality: string | null;
            }>
          >`
            SELECT date, price_rial, shares_count, mcap_rial, mcap_usd,
                   fx_rate_rial, fx_quality
            FROM market_cap_history
            WHERE symbol = ${sym}
            ORDER BY date DESC
            LIMIT 1
          `;

          const r = rows[0];
          if (!r || r.mcap_rial === null) {
            return {
              symbol: sym,
              error: "no market-cap data for this symbol",
            };
          }

          return {
            symbol: sym,
            date: r.date.toISOString().split("T")[0],
            priceRial: Number(r.price_rial ?? 0),
            sharesCount: r.shares_count ?? 0,
            mcapRial: Number(r.mcap_rial),
            mcapUsd: r.mcap_usd !== null ? Number(r.mcap_usd) : null,
            fxRateToman: r.fx_rate_rial !== null ? Number(r.fx_rate_rial) / 10 : null,
            fxQualityStatus: r.fx_quality ?? "fallback",
          };
        },
      );

      reply.header("x-cache", hit ? "HIT" : "MISS");
      return reply.send(data);
    },
  );

  // GET /api/mcap-series/:symbol/sales?months=N
  // Monthly sales series (Rial + USD), sourced from Codal + Wallex FX
  server.get(
    `${prefix}/:symbol/sales`,
    {
      schema: {
        tags: ["mcap"],
        summary: "Get monthly sales series with Rial + USD amounts",
        params: { type: "object", properties: { symbol: { type: "string" } } },
        querystring: {
          type: "object",
          properties: {
            months: { type: "integer", minimum: 1, maximum: 48, default: 36 },
          },
        },
      },
    },
    async (req, reply) => {
      const { symbol } = req.params as { symbol: string };
      const { months = 36 } = req.query as { months?: number };
      const sym = decodeURIComponent(symbol);

      const { data, hit } = await getOrSet(
        server,
        `mcap-sales:${sym}:months=${months}`,
        120,
        async () => {
          const rows = await server.db<
            Array<{
              month_end: Date;
              sales_amount: number | null;
              sales_usd: number | null;
              domestic_usd: number | null;
              export_usd: number | null;
              service_usd: number | null;
              ytd_total_usd: number | null;
              ytd_prior_year_usd: number | null;
              fx_rate_rial: number | null;
              fx_quality: string | null;
              fx_sources: string[] | null;
              source_url: string | null;
              detail: any;
            }>
          >`
            SELECT
              month_end,
              sales_amount::float8 AS sales_amount,
              sales_usd::float8 AS sales_usd,
              domestic_usd::float8 AS domestic_usd,
              export_usd::float8 AS export_usd,
              service_usd::float8 AS service_usd,
              ytd_total_usd::float8 AS ytd_total_usd,
              ytd_prior_year_usd::float8 AS ytd_prior_year_usd,
              fx_rate_rial::float8 AS fx_rate_rial,
              fx_quality,
              fx_sources,
              source_url,
              detail
            FROM monthly_sales
            WHERE symbol = ${sym}
            ORDER BY month_end DESC
            LIMIT ${months}
          `;

          // Reverse to chronological order for YTD accumulation
          rows.reverse();

          const toNum = (v: unknown): number | null => {
            if (v === null || v === undefined || v === "") return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          };

          const monthsData = rows.map((r) => {
            const d = (r.detail ?? {}) as Record<string, unknown>;
            const jal = dateToJalali(r.month_end);
            const fxRateToman =
              r.fx_rate_rial !== null ? Number(r.fx_rate_rial) / 10 : null;

            return {
              monthEnd: r.month_end.toISOString().split("T")[0],
              jy: jal.jy,
              jm: jal.jm,
              totalRial: toNum(r.sales_amount),
              totalUsd: toNum(r.sales_usd),
              domesticRial: toNum(d.domesticMonthly),
              domesticUsd: toNum(r.domestic_usd),
              exportRial: toNum(d.exportMonthly),
              exportUsd: toNum(r.export_usd),
              serviceRial: toNum(d.serviceMonthly),
              serviceUsd: toNum(r.service_usd),
              ytdTotalRial: toNum(d.ytdSalesTotal),
              ytdTotalUsd: toNum(r.ytd_total_usd),
              ytdPriorYearRial: toNum(d.priorYtdSalesTotal),
              ytdPriorYearUsd: toNum(r.ytd_prior_year_usd),
              fxRateToman,
              fxQualityStatus: r.fx_quality ?? "fallback",
              fxSources: r.fx_sources ?? [],
              reportUrl: r.source_url,
            };
          });

          const currentJy = monthsData[monthsData.length - 1]?.jy ?? 0;
          const ytdRial = monthsData
            .filter((m) => m.jy === currentJy)
            .reduce((sum, m) => sum + (m.totalRial ?? 0), 0);
          const ytdUsd = monthsData
            .filter((m) => m.jy === currentJy)
            .reduce((sum, m) => sum + (m.totalUsd ?? 0), 0);

          return {
            symbol: sym,
            months: monthsData,
            ytdTotalRial: ytdRial || null,
            ytdTotalUsd: ytdUsd || null,
            meta: { count: monthsData.length },
          };
        },
      );

      reply.header("x-cache", hit ? "HIT" : "MISS");
      return reply.send(data);
    },
  );
};
