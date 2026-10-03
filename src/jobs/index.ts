/**
 * Bourse Radar — Background Job Scheduler
 * Tehran Stock Exchange data ingestion via node-cron
 */

import cron from "node-cron";
import type { FastifyInstance } from "fastify";
import { logger } from "#utils/logger";
import {
  scrapeAllSymbols,
  fetchCurrentPrices,
  upsertStocks,
  insertPrices,
  pruneOldPrices,
  syncMonthlySales,
  syncQuarterlyFinancials,
  recomputeForwardPe,
  refreshRankings,
  syncFxRates,
  syncMarketCapHistory,
  WATCHLIST,
} from "#services/ingest";

const TZ = "Asia/Tehran";

interface JobConfig {
  name: string;
  schedule: string;
  task: () => Promise<void>;
}

export async function initializeJobs(server: FastifyInstance): Promise<void> {
  const symbols = WATCHLIST.map((w) => w.sym);

  const jobs: JobConfig[] = [
    // ── 0. FX rate (daily at 6:01 AM — before other jobs need USD conversion) ──
    {
      name: "ingest-fx-rate",
      schedule: "1 6 * * *",
      task: async () => {
        logger.info("[job] fetching USD/IRR rate from Wallex + Nobitex");
        const n = await syncFxRates(server.db);
        logger.info(`[job] FX rate stored (${n > 0 ? "ok" : "failed"})`);
      },
    },

    // ── 1. Daily symbol + sector refresh (every day at 6 AM) ──
    {
      name: "ingest-symbols",
      schedule: "0 6 * * *",
      task: async () => {
        logger.info("[job] ingesting symbol list from TSETMC");
        const s = await scrapeAllSymbols();
        const n = await upsertStocks(server.db, s);
        logger.info(`[job] upserted ${n} stocks`);
      },
    },

    // ── 2. Price ticks every 5 min during market hours ──
    {
      name: "ingest-prices",
      schedule: "*/5 9-12 * * 0-4",
      task: async () => {
        logger.info("[job] ingesting real-time prices");
        const s = await fetchCurrentPrices(server.db);
        const n = await insertPrices(server.db, s);
        logger.info(`[job] inserted ${n} price ticks`);
      },
    },

    // ── 2b. Market-cap history (daily at 6:30 AM, uses prices + fx) ──
    {
      name: "ingest-market-cap-history",
      schedule: "30 6 * * *",
      task: async () => {
        logger.info("[job] building market-cap history from TSETMC prices");
        const n = await syncMarketCapHistory(server.db);
        logger.info(`[job] ${n} market-cap points stored`);
      },
    },

    // ── 3. Monthly sales (daily at 2 PM, after Codal publications) ──
    {
      name: "ingest-monthly-sales",
      schedule: "0 14 * * 0-4",
      task: async () => {
        logger.info("[job] ingesting monthly sales from Codal.ir");
        const n = await syncMonthlySales(server.db, symbols);
        logger.info(`[job] synced ${n} monthly sales records`);
      },
    },

    // ── 4. Quarterly financials (daily at 3 PM, Playwright-heavy, 10-15 min) ──
    {
      name: "ingest-quarterly-financials",
      schedule: "0 15 * * 0-4",
      task: async () => {
        logger.info("[job] ingesting quarterly financials (Playwright)");
        const n = await syncQuarterlyFinancials(server.db, symbols);
        logger.info(`[job] synced ${n} quarterly records`);
      },
    },

    // ── 5. Forward P/E (daily at 8 PM, after all data is fresh) ──
    {
      name: "compute-forward-pe",
      schedule: "0 20 * * *",
      task: async () => {
        logger.info("[job] computing Forward P/E for all stocks");
        const n = await recomputeForwardPe(server.db);
        logger.info(`[job] computed Forward P/E for ${n} stocks`);
      },
    },

    // ── 6. Rankings refresh (daily at 9 PM, after P/E) ──
    {
      name: "compute-rankings",
      schedule: "0 21 * * *",
      task: async () => {
        logger.info("[job] refreshing rankings materialized view");
        await refreshRankings(server.db);
      },
    },

    // ── 8. Retention prune (daily at 5 AM — before the day's ingestion)
    {
      name: "prune-prices",
      schedule: "0 5 * * *",
      task: async () => {
        logger.info("[job] pruning prices older than 30 days");
        const n = await pruneOldPrices(server.db, 30);
        logger.info(`[job] pruned ${n} price rows`);
      },
    },

    // ── 7. LLM narratives (daily at 10 PM, for top-20 stocks) ──
    {
      name: "generate-narratives",
      schedule: "0 22 * * *",
      task: async () => {
        logger.info("[job] generating LLM narratives for top-20 stocks");
        // TODO: call LlmNarrator for top-20 ranked stocks
      },
    },
  ];

  for (const job of jobs) {
    cron.schedule(
      job.schedule,
      async () => {
        const startedAt = Date.now();
        try {
          await job.task();
          const ms = Date.now() - startedAt;
          logger.info(`[job] ${job.name} completed in ${ms}ms`);
        } catch (err) {
          logger.error(err, `[job] ${job.name} failed`);
        }
      },
      { timezone: TZ },
    );
    logger.info(`[job] ${job.name} scheduled: ${job.schedule} (${TZ})`);
  }

  server.addHook("onClose", () => {
    cron.getTasks().forEach((t) => t.stop());
    logger.info("All cron jobs stopped");
  });
}