import postgres from "postgres";
import { tsetmc, type ResolvedInstrument } from "#scrapers/tsetmc";
import {
  fetchFxRate,
  type FxRate,
  type FxSource,
  type FxQualityStatus,
} from "#scrapers/fx";
import {
  fetchMonthlySales,
  fetchLatestQuarterlyFinancials,
  closeBrowser,
  searchLetters,
  filterMonthlySalesLetters,
  fetchReportHtml,
  extractMonthlySalesFull,
  extractJalaliPeriodEnd,
  isCodalCoolingDown,
  codalThrottleStatus,
  codalCooldownRemainingMs,
  type CodalLetter,
  type MonthlyReportResult,
} from "#scrapers/codal";

// Re-exported so routes/services can report throttle state without reaching
// into the scraper module directly.
export { isCodalCoolingDown, codalThrottleStatus, codalCooldownRemainingMs };
import { jalaliToGregorian, toIsoDate } from "#utils/jalali";

type PostgresDb = ReturnType<typeof postgres>;

export type WatchlistType = "general" | "bank" | "insurance" | "holding";

export type WatchlistItem = {
  sym: string;
  name: string;
  type: WatchlistType;
};

export const WATCHLIST: Array<WatchlistItem> = [
  // ── فلزات اساسی (Basic Metals) ──────────────────────
  { sym: "فولاد", name: "فولاد مبارکه", type: "general" },
  { sym: "فخوز", name: "فولاد خوزستان", type: "general" },
  { sym: "فخاس", name: "فولاد خراسان", type: "general" },
  { sym: "ذوب", name: "ذوب‌آهن اصفهان", type: "general" },
  { sym: "فملی", name: "ملی صنایع مس ایران", type: "general" },
  { sym: "فایرا", name: "آلومینیوم ایران", type: "general" },
  { sym: "فمراد", name: "آلومراد", type: "general" },
  { sym: "فپارس", name: "آلومینیوم پارس", type: "general" },
  { sym: "فالوم", name: "آلومتک", type: "general" },
  { sym: "فزرین", name: "معدن زرین آسیا", type: "general" },
  { sym: "فجر", name: "فولاد امیرکبیر کاشان", type: "general" },
  { sym: "فاراک", name: "ماشین‌سازی اراک", type: "general" },
  { sym: "فوکا", name: "فولاد کاویان", type: "general" },
  { sym: "فسرب", name: "ملی سرب و روی", type: "general" },
  { sym: "فسوژ", name: "سوژمیران", type: "general" },

  { sym: "فسبزوار", name: "پارس فولاد سبزوار", type: "general" },
  { sym: "فاسمین", name: "کالسیمین", type: "general" },
  { sym: "کروی", name: "توسعه معادن روی ایران", type: "general" },
  { sym: "کگل", name: "گل‌گهر", type: "general" },
  { sym: "کچاد", name: "چادرملو", type: "general" },

  // ── زراعت و دام (Agriculture & Livestock) ──────────
  { sym: "زشگزا", name: "شیر و گوشت زاگرس شهرکرد", type: "general" },

  // ── پالایش و پتروشیمی (Refining & Petrochemical) ────
  { sym: "شپنا", name: "پالایش نفت اصفهان", type: "general" },
  { sym: "شبندر", name: "پالایش نفت بندرعباس", type: "general" },
  { sym: "شتران", name: "پالایش نفت تهران", type: "general" },
  { sym: "شبریز", name: "پالایش نفت تبریز", type: "general" },
  { sym: "شپدیس", name: "پتروشیمی پردیس", type: "general" },
  { sym: "شیراز", name: "پتروشیمی شیراز", type: "general" },
  { sym: "شاراک", name: "پتروشیمی شازند", type: "general" },
  { sym: "شپارس", name: "بین‌المللی محصولات پارس", type: "general" },
  { sym: "شپاکسا", name: "پاکسان", type: "general" },
  { sym: "شخارک", name: "پتروشیمی خارک", type: "general" },
  { sym: "تاپیکو", name: "سرمایه‌گذاری نفت و گاز تامین", type: "general" },

  // ── شیمیایی (Chemicals) ─────────────────────────────
  { sym: "شکام", name: "صنایع شیمیایی کیمیاگران امروز", type: "general" },
  { sym: "شسینا", name: "صنایع شیمیایی سینا", type: "general" },
  { sym: "شبصیر", name: "پتروشیمی قائد بصیر", type: "general" },
  { sym: "شغدیر", name: "پتروشیمی غدیر", type: "general" },
  { sym: "شجم", name: "صنایع پتروشیمی تخت جمشید", type: "general" },
  { sym: "شفن", name: "پتروشیمی فن‌آوران", type: "general" },

  // ── خودرو (Automotive) ──────────────────────────────
  { sym: "خودرو", name: "ایران خودرو", type: "general" },
  { sym: "خساپا", name: "سایپا", type: "general" },
  { sym: "خپارس", name: "پارس خودرو", type: "general" },
  { sym: "پتایر", name: "ایران تایر", type: "general" },
  { sym: "پاسا", name: "ایران یاسا تایر", type: "general" },

  // ── دارویی (Pharmaceuticals) ────────────────────────
  { sym: "برکت", name: "گروه دارویی برکت", type: "general" },
  { sym: "دتولید", name: "داروسازی تولید دارو", type: "general" },
  { sym: "دسبحا", name: "گروه دارویی سبحان", type: "general" },
  { sym: "دلقما", name: "دارویی لقمان", type: "general" },
  { sym: "دعبید", name: "لابراتوار داروسازی دکتر عبیدی", type: "general" },
  { sym: "دپارس", name: "پارس دارو", type: "general" },
  { sym: "دیران", name: "ایران دارو", type: "general" },
  { sym: "دالبر", name: "البرز دارو", type: "general" },

  // ── غذایی (Food) ────────────────────────────────────
  { sym: "غپونه", name: "نوش پونه مشهد", type: "general" },
  { sym: "غشهد", name: "شهد ایران", type: "general" },
  { sym: "غچین", name: "کشت و صنعت چین چین", type: "general" },
  { sym: "غگرجی", name: "بیسکویت گرجی", type: "general" },
  { sym: "غبهنوش", name: "بهنوش ایران", type: "general" },
  { sym: "غدانه", name: "پنبه و دانه های روغنی خراسان", type: "general" },

  // ── سیمان (Cement) ──────────────────────────────────
  { sym: "ستران", name: "سیمان تهران", type: "general" },
  { sym: "سفارس", name: "سیمان فارس و خوزستان", type: "general" },
  { sym: "سبزوا", name: "سیمان لار سبزوار", type: "general" },

  // ── صنعتی و سایر (Industrial & Others) ──────────────
  { sym: "کپشیر", name: "پشم شیشه ایران", type: "general" },
  { sym: "تپمپی", name: "پمپ‌سازی ایران", type: "general" },
  { sym: "پلاسک", name: "پلاسکوکار", type: "general" },
  { sym: "کسرام", name: "پارس سرام", type: "general" },
  { sym: "کچینی", name: "کارخانه چینی ایران", type: "general" },
  { sym: "لپارس", name: "پارس الکتریک", type: "general" },
  { sym: "حکشتی", name: "کشتیرانی", type: "general" },
  { sym: "تمحرکه", name: "ماشین‌سازی نیرومحرکه", type: "general" },

  // ── بانک‌ها (Banks) ─────────────────────────────────
  { sym: "وبملت", name: "بانک ملت", type: "bank" },
  { sym: "وبصادر", name: "بانک صادرات", type: "bank" },
  { sym: "وپاسار", name: "بانک پاسارگاد", type: "bank" },
  { sym: "وتجارت", name: "بانک تجارت", type: "bank" },
  { sym: "وبفارس", name: "بانک پارسیان", type: "bank" },
  { sym: "وکار", name: "بانک کارآفرین", type: "bank" },
  { sym: "ونوین", name: "بانک اقتصاد نوین", type: "bank" },
  { sym: "وخاور", name: "بانک خاورمیانه", type: "bank" },
  { sym: "وسینا", name: "بانک سینا", type: "bank" },
  { sym: "وپست", name: "پست بانک", type: "bank" },

  // ── بیمه (Insurance) ────────────────────────────────
  { sym: "وبیمه", name: "بیمه ایران", type: "insurance" },
  { sym: "وپارسیان", name: "بیمه پارسیان", type: "insurance" },
  { sym: "ودی", name: "بیمه دی", type: "insurance" },
  { sym: "ونیکی", name: "بیمه نیکان", type: "insurance" },
  { sym: "آسیا", name: "بیمه آسیا", type: "insurance" },
  { sym: "البرز", name: "بیمه البرز", type: "insurance" },
  { sym: "دانا", name: "بیمه دانا", type: "insurance" },

  // ── هلدینگ‌ها (Holdings) ────────────────────────────
  { sym: "پارسان", name: "گسترش نفت و گاز پارسیان", type: "holding" },
  { sym: "شستا", name: "سرمایه‌گذاری تأمین اجتماعی", type: "holding" },
  { sym: "خگستر", name: "گسترش سرمایه‌گذاری ایران‌خودرو", type: "holding" },
  { sym: "وغدیر", name: "سرمایه‌گذاری غدیر", type: "holding" },
  { sym: "وامید", name: "سرمایه‌گذاری امید", type: "holding" },
  { sym: "وصندوق", name: "سرمایه‌گذاری صندوق بازنشستگی", type: "holding" },
];

/** چک سریع عضویت نماد در واچ‌لیست */
const WATCHLIST_SYMBOLS = new Set(WATCHLIST.map((w) => w.sym));

export function isInWatchlist(sym: string): boolean {
  return WATCHLIST_SYMBOLS.has(sym);
}

const WATCHLIST_BY_SYM = new Map(WATCHLIST.map((w) => [w.sym, w]));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tunables */
const DELAY_MS = 900;
const FETCH_TIMEOUT_MS = 25_000;
const RETRY_ATTEMPTS = 3;
const CODAL_CONCURRENCY = 3;
const MONTHLY_SALES_DEPTH = 36;

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = RETRY_ATTEMPTS,
  baseDelayMs = 500,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(baseDelayMs * (i + 1));
    }
  }
  throw lastErr;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) continue;
      results[i] = await fn(item, i);
    }
  }
  // Promise.all rejects on the FIRST failure while the other workers keep
  // running. Their eventual rejections would then surface as unhandled
  // rejections, which the process-level handler treats as fatal and takes the
  // whole API down. Settle every worker so one bad item can't kill siblings.
  await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  ).then((outcomes) => {
    const failure = outcomes.find(
      (o): o is PromiseRejectedResult => o.status === "rejected",
    );
    if (failure) throw failure.reason;
  });
  return results;
}

// ═══════════════════════════════════════════════════════════════
// FX context — shared by every writer that stamps USD columns
// ═══════════════════════════════════════════════════════════════

interface FxContext {
  rateRial: number | null;
  quality: FxQualityStatus | null;
  sources: string[] | null;
  toUsd: (rialMillions: number | null) => number | null;
}

async function resolveFxContext(sql: PostgresDb): Promise<FxContext> {
  const fxRate = await getFxRateForDate(sql, null).catch(() => null);
  const rateRial = fxRate?.rateRial ?? null;
  return {
    rateRial,
    quality: fxRate?.quality ?? null,
    sources: fxRate ? Array.from(fxRate.sources) : null,
    toUsd: (rialMillions) =>
      rialMillions != null && rateRial && rateRial > 0
        ? (rialMillions * 1_000_000) / rateRial
        : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// Single monthly-sales writer — used by BOTH syncMonthlySales
// and ingestArchiveForSymbol (this is the de-duplicated core).
// ═══════════════════════════════════════════════════════════════

interface MonthlySalesUpsert {
  symbol: string;
  monthEnd: string; // ISO Gregorian
  salesAmount: number;
  reportUrl: string;
  detail: unknown;
  ytdTotal: number | null;
  ytdPriorYear: number | null;
  domesticRial: number | null;
  exportRial: number | null;
  serviceRial: number | null;
}

async function upsertMonthlySalesRow(
  sql: PostgresDb,
  fx: FxContext,
  r: MonthlySalesUpsert,
): Promise<void> {
  await sql`
    INSERT INTO monthly_sales (symbol, month_end, sales_amount, is_estimated, source_url, fetched_at, detail,
                               sales_usd, domestic_usd, export_usd, service_usd,
                               ytd_total_usd, ytd_prior_year_usd,
                               fx_rate_rial, fx_quality, fx_sources)
    VALUES (
      ${r.symbol}, ${r.monthEnd}, ${r.salesAmount}, false, ${r.reportUrl}, NOW(),
      ${JSON.stringify(r.detail ?? null)}::jsonb,
      ${fx.toUsd(r.salesAmount)}, ${fx.toUsd(r.domesticRial)},
      ${fx.toUsd(r.exportRial)}, ${fx.toUsd(r.serviceRial)},
      ${fx.toUsd(r.ytdTotal)}, ${fx.toUsd(r.ytdPriorYear)},
      ${fx.rateRial}, ${fx.quality}, ${fx.sources}
    )
    ON CONFLICT (symbol, month_end) DO UPDATE SET
      sales_amount = EXCLUDED.sales_amount,
      source_url  = EXCLUDED.source_url,
      fetched_at  = NOW(),
      detail      = EXCLUDED.detail,
      sales_usd     = EXCLUDED.sales_usd,
      domestic_usd  = EXCLUDED.domestic_usd,
      export_usd    = EXCLUDED.export_usd,
      service_usd   = EXCLUDED.service_usd,
      ytd_total_usd       = EXCLUDED.ytd_total_usd,
      ytd_prior_year_usd  = EXCLUDED.ytd_prior_year_usd,
      fx_rate_rial  = EXCLUDED.fx_rate_rial,
      fx_quality    = EXCLUDED.fx_quality,
      fx_sources    = EXCLUDED.fx_sources
  `;
}

const num = (v: unknown): number | null => (v != null ? Number(v) : null);

// ═══════════════════════════════════════════════════════════════
// Phase 1: TSETMC symbols + prices
// ═══════════════════════════════════════════════════════════════

export async function scrapeAllSymbols(): Promise<ResolvedInstrument[]> {
  const out: ResolvedInstrument[] = [];
  for (const item of WATCHLIST) {
    try {
      const snap = await tsetmc.resolveSymbol(item.sym, item.name);
      if (snap) {
        out.push(snap);
        console.log(`  [${item.sym}] ✓ ${snap.sector} price=${snap.lastPrice}`);
      } else {
        console.log(`  [${item.sym}] ✗ not found`);
      }
    } catch (e: unknown) {
      console.error(
        `  [${item.sym}] ✗ ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    await sleep(DELAY_MS);
  }
  return out;
}

export async function upsertStocks(
  sql: PostgresDb,
  stocks: ResolvedInstrument[],
): Promise<number> {
  let count = 0;
  for (const s of stocks) {
    const wl = WATCHLIST_BY_SYM.get(s.symbol);
    await sql`
      INSERT INTO stocks (symbol, name, sector, isin, shares_outstanding,
                          is_bank, is_insurance, is_holding_company, updated_at)
      VALUES (${s.symbol}, ${s.name}, ${s.sector}, ${s.isin}, ${s.shares},
              ${wl?.type === "bank"}, ${wl?.type === "insurance"},
              ${wl?.type === "holding"}, NOW())
      ON CONFLICT (symbol) DO UPDATE SET
        name = EXCLUDED.name,
        sector = EXCLUDED.sector,
        isin = EXCLUDED.isin,
        shares_outstanding = EXCLUDED.shares_outstanding,
        is_bank = EXCLUDED.is_bank,
        is_insurance = EXCLUDED.is_insurance,
        is_holding_company = EXCLUDED.is_holding_company,
        updated_at = NOW()
    `;
    count++;
  }
  return count;
}

export async function insertPrices(
  sql: PostgresDb,
  stocks: ResolvedInstrument[],
): Promise<number> {
  let count = 0;
  for (const s of stocks) {
    try {
      await sql`
        INSERT INTO prices (symbol, timestamp, last_price, volume, value, change_percent)
        VALUES (${s.symbol}, NOW(), ${s.lastPrice}, ${s.volume}, ${s.value}, ${s.changePct})
        ON CONFLICT (symbol, timestamp) DO UPDATE SET
          last_price = EXCLUDED.last_price,
          volume = EXCLUDED.volume,
          value = EXCLUDED.value,
          change_percent = EXCLUDED.change_percent
      `;
      count++;
    } catch {
      // A duplicate bare-NOW() timestamp (two runs in the same millisecond)
      // is harmless — the next tick overwrites it.
    }
  }
  return count;
}

/**
 * Retention prune for the append-only `prices` table.
 *
 * Prices are 5-minute ticks (~288/day/symbol). Nothing downstream needs more
 * than ~30 days: market-cap history is a daily rollup, P/E uses latest only.
 * Without this the table grows ~800K rows/year and every
 * `ORDER BY timestamp DESC LIMIT 1` lateral slows down.
 *
 * Runs as a daily cron job; safe to call on demand (idempotent).
 */
export async function pruneOldPrices(
  sql: PostgresDb,
  olderThanDays = 30,
): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    WITH deleted AS (
      DELETE FROM prices
      WHERE timestamp < NOW() - (${olderThanDays} || ' days')::interval
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM deleted
  `;
  return rows[0]?.n ?? 0;
}

// ═══════════════════════════════════════════════════════════════
// Phase 2: Codal monthly sales (live scrape path)
// ═══════════════════════════════════════════════════════════════

export interface MonthlySalesSyncOptions {
  /** How many recent letters to fetch per symbol (1 = only the latest month). */
  maxMonths?: number;
  /** Skip months already ingested within this many days (dedup window). */
  skipKnownDays?: number;
}

export async function syncMonthlySales(
  sql: PostgresDb,
  symbols: string[],
  maxMonthEnd?: Date,
  opts: MonthlySalesSyncOptions = {},
): Promise<number> {
  if (maxMonthEnd) {
    await sql`DELETE FROM monthly_sales WHERE month_end > ${maxMonthEnd}`;
  }

  const maxMonths = opts.maxMonths ?? MONTHLY_SALES_DEPTH;
  // Re-running ingest used to re-scrape (and re-upsert) months we already
  // have, which looks like "duplicate data". Skip anything already in the DB
  // unless it's older than this window — that's also when revisions (اصلاحیه)
  // get picked up.
  const skipKnownDays = opts.skipKnownDays ?? 7;

  let count = 0;
  let skippedKnown = 0;
  let skippedForThrottle = 0;

  const eligible = symbols.filter((sym) => {
    const wl = WATCHLIST_BY_SYM.get(sym);
    return !wl || wl.type === "general";
  });
  if (eligible.length !== symbols.length) {
    console.log(
      `  ↷ skipped ${symbols.length - eligible.length} financial instruments (bank/insurance/holding)`,
    );
  }

  await mapWithConcurrency(eligible, CODAL_CONCURRENCY, async (symbol) => {
    // The breaker is per-IP and Codal's ban covers the whole host. Continuing
    // through the remaining watchlist while banned only extends the ban, so
    // stop early and let the cooldown run.
    if (isCodalCoolingDown()) {
      skippedForThrottle++;
      return;
    }
    try {
      // Race the fetch against a deadline, but CLEAR the timer on success and
      // keep a no-op catch on the losing promise. A `setTimeout` that fires
      // after the fetch already won leaves a rejected promise nobody awaits,
      // which surfaces as an unhandled rejection.
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error("timeout")),
          (FETCH_TIMEOUT_MS * Math.max(maxMonths, 3)) / 3,
        );
      });
      const fetching = fetchMonthlySales(symbol, maxMonths);
      fetching.catch(() => {}); // orphan guard: never let this reject unhandled

      const sales: MonthlyReportResult[] = await withRetry(() =>
        Promise.race([fetching, deadline]),
      ).finally(() => {
        if (timer) clearTimeout(timer);
      });

      // Dedup: which month_ends do we already have for this symbol?
      const knownRows = await sql<{ month_end: Date | string }[]>`
        SELECT month_end FROM monthly_sales
        WHERE symbol = ${symbol}
          AND fetched_at > NOW() - (${skipKnownDays} || ' days')::interval
      `;
      const known = new Set(
        knownRows.map((r) =>
          r.month_end instanceof Date
            ? r.month_end.toISOString().slice(0, 10)
            : String(r.month_end).slice(0, 10),
        ),
      );

      const fx = await resolveFxContext(sql);

      let written = 0;
      for (const s of sales) {
        const monthEnd = toIsoDate(
          jalaliToGregorian(s.periodEnd.jy, s.periodEnd.jm, s.periodEnd.jd),
        );
        if (known.has(monthEnd)) {
          skippedKnown++;
          continue;
        }
        const d: any = s.detail ?? {};
        await upsertMonthlySalesRow(sql, fx, {
          symbol,
          monthEnd,
          salesAmount: s.amount,
          reportUrl: s.reportUrl,
          detail: s.detail ?? null,
          ytdTotal: num(s.full?.ytdTotal),
          ytdPriorYear: num(s.full?.ytdPriorYearTotal),
          domesticRial: num(d.domesticMonthly),
          exportRial: num(d.exportMonthly),
          serviceRial: num(d.serviceMonthly),
        });
        count++;
        written++;
      }
      console.log(
        `  [${symbol}] ✓ ${written} monthly sales records` +
          (sales.length - written
            ? ` (${sales.length - written} already in DB, skipped)`
            : ""),
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  [${symbol}] ✗ ${msg.slice(0, 160)}`);
    }
    await sleep(DELAY_MS);
  });

  if (skippedKnown) {
    console.log(`  ↷ ${skippedKnown} month(s) already in DB — skipped (dedup)`);
  }
  if (skippedForThrottle) {
    console.warn(
      `  ⚠ ${skippedForThrottle} symbols skipped — ${codalThrottleStatus()}`,
    );
  }
  return count;
}

/** Only the most recent month per symbol — the daily refresh path. */
export async function syncLatestMonthlySales(
  sql: PostgresDb,
  symbols: string[],
): Promise<number> {
  return syncMonthlySales(sql, symbols, undefined, { maxMonths: 1 });
}

// ═══════════════════════════════════════════════════════════════
// Phase 3: Codal quarterly financials
// ═══════════════════════════════════════════════════════════════

export interface DiscreteQuarter {
  fiscalYear: number;
  quarter: number;
  periodEnd: string;
  revenue: number | null;
  netProfit: number | null;
  margin: number | null;
}

export function toDiscreteQuarters(f: {
  periodEnds: string[];
  durationMonths?: number[];
  revenues: Array<number | null>;
  netProfits: Array<number | null>;
}): DiscreteQuarter[] {
  interface Cum {
    fiscalYear: number;
    quarter: number;
    periodEnd: string;
    duration: number;
    revenue: number | null;
    netProfit: number | null;
  }

  const cums: Cum[] = [];
  for (let i = 0; i < f.periodEnds.length; i++) {
    const pe = f.periodEnds[i];
    if (!pe) continue;
    const jy = parseInt(pe.slice(0, 4), 10);
    const jm = parseInt(pe.slice(5, 7), 10);
    const jd = parseInt(pe.slice(8, 10), 10);
    if (!jy || !jm || !jd) continue;

    const labelled = f.durationMonths?.[i] ?? 0;
    const duration =
      labelled > 0 ? labelled : Math.min(4, Math.ceil(jm / 3)) * 3;

    cums.push({
      fiscalYear: jy,
      quarter: Math.min(4, Math.max(1, Math.round(duration / 3))),
      periodEnd: toIsoDate(jalaliToGregorian(jy, jm, jd)),
      duration,
      revenue: f.revenues[i] ?? null,
      netProfit: f.netProfits[i] ?? null,
    });
  }

  const byYear = new Map<number, Cum[]>();
  for (const c of cums) {
    const arr = byYear.get(c.fiscalYear) ?? [];
    arr.push(c);
    byYear.set(c.fiscalYear, arr);
  }

  const out: DiscreteQuarter[] = [];
  for (const [, arr] of byYear) {
    arr.sort((a, b) => a.duration - b.duration);

    for (let i = 0; i < arr.length; i++) {
      const cur = arr[i]!;
      const prev = i > 0 ? arr[i - 1]! : null;

      let revenue: number | null;
      let netProfit: number | null;

      if (cur.duration <= 3) {
        revenue = cur.revenue;
        netProfit = cur.netProfit;
      } else if (!prev) {
        continue;
      } else {
        revenue =
          prev.revenue === null || cur.revenue === null
            ? null
            : cur.revenue - prev.revenue;
        netProfit =
          prev.netProfit === null || cur.netProfit === null
            ? null
            : cur.netProfit - prev.netProfit;
      }

      const margin =
        revenue !== null && netProfit !== null && revenue > 0
          ? netProfit / revenue
          : null;

      out.push({
        fiscalYear: cur.fiscalYear,
        quarter: cur.quarter,
        periodEnd: cur.periodEnd,
        revenue,
        netProfit,
        margin,
      });
    }
  }

  return out;
}

export async function syncQuarterlyFinancials(
  sql: PostgresDb,
  symbols: string[],
  _minYear?: number,
  maxYear?: number,
): Promise<number> {
  let count = 0;

  await mapWithConcurrency(symbols, 2, async (symbol) => {
    if (isCodalCoolingDown()) return;
    try {
      const q = await withRetry(() =>
        fetchLatestQuarterlyFinancials(symbol, maxYear),
      );
      if (!q) return;

      const f = q.financials;
      const quarters = toDiscreteQuarters({
        periodEnds: f.periodEnds ?? [],
        durationMonths: f.durationMonths ?? [],
        revenues: f.revenues ?? [],
        netProfits: f.netProfits ?? [],
      });

      if (quarters.length === 0) {
        console.log(`  [${symbol}] ✗ no quarterly periods parsed`);
        return;
      }

      for (const qtr of quarters) {
        if (qtr.margin === null) {
          console.log(
            `  [${symbol}] ✗ Q${qtr.quarter} ${qtr.fiscalYear} margin=null, skipping`,
          );
          continue;
        }

        await sql`
          INSERT INTO quarterly_financials (
            symbol, fiscal_year, quarter, period_end,
            revenue, net_profit, net_margin, shares_outstanding,
            source_url, fetched_at
          )
          VALUES (
            ${symbol}, ${qtr.fiscalYear}, ${qtr.quarter}, ${qtr.periodEnd},
            ${qtr.revenue}, ${qtr.netProfit}, ${qtr.margin}, ${f.sharesOutstanding},
            ${q.reportUrl}, NOW()
          )
          ON CONFLICT (symbol, fiscal_year, quarter) DO UPDATE SET
            period_end = EXCLUDED.period_end,
            revenue = EXCLUDED.revenue,
            net_profit = EXCLUDED.net_profit,
            net_margin = EXCLUDED.net_margin,
            shares_outstanding = EXCLUDED.shares_outstanding,
            source_url = EXCLUDED.source_url,
            fetched_at = NOW()
        `;

        const marginStr = (qtr.margin * 100).toFixed(1) + "%";
        const revStr =
          qtr.revenue != null ? (qtr.revenue / 1e9).toFixed(1) + "B" : "—";
        console.log(
          `  [${symbol}] ✓ Q${qtr.quarter} ${qtr.fiscalYear} rev=${revStr} margin=${marginStr}`,
        );
        count++;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  [${symbol}] ✗ ${msg.slice(0, 100)}`);
    }
  });

  return count;
}
// ─────────────────────────────────────────────────────────────────────────
// Phase 4: Forward P/E
// ─────────────────────────────────────────────────────────────────────────
export async function recomputeForwardPe(sql: PostgresDb): Promise<number> {
  const rows = await sql`
    WITH monthly_base AS (
      SELECT
        symbol,
        month_end,
        ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY month_end DESC) AS rn,

        -- فروش ماهانه (چند لایه fallback)
        COALESCE(
          NULLIF(sales_amount, 0),
          NULLIF((detail->>'monthlySalesTotal')::numeric, 0),
          NULLIF((detail->>'domesticMonthly')::numeric, 0) +
            COALESCE(NULLIF((detail->>'exportMonthly')::numeric, 0), 0),
          0
        ) AS revenue,

        -- service / بهای تمام‌شده (خواندن مقاوم از چند مسیر)
        COALESCE(
          -- ۱) serviceMonthly در سطح بالا (اگر منفی و غیرصفر باشد)
          NULLIF((detail->>'serviceMonthly')::numeric, 0),
          -- ۲) ردیف rowCode=11 در totals
          (
            SELECT (t->>'valuePeriod')::numeric
            FROM jsonb_array_elements(COALESCE(detail->'totals', '[]'::jsonb)) AS t
            WHERE (t->>'rowCode')::int = 11
            LIMIT 1
          ),
          -- ۳) اگر gross_profit در detail باشد، service = gross_profit - revenue
          NULLIF((detail->>'grossProfitMonthly')::numeric, 0)
            - NULLIF((detail->>'monthlySalesTotal')::numeric, 0),
          0
        ) AS service
      FROM monthly_sales
    ),

    revenue_last3 AS (
      SELECT
        symbol,
        SUM(revenue) AS sum_sales,
        AVG(NULLIF(revenue, 0)) AS avg_sales,
        SUM(revenue + service) AS sum_gross,   -- service معمولاً منفی است
        COUNT(*) FILTER (WHERE revenue > 0) AS month_count,
        -- آیا حداقل یک ماه service غیرصفر داریم؟
        COUNT(*) FILTER (WHERE service <> 0) AS month_count_with_service
      FROM monthly_base
      WHERE rn <= 3
      GROUP BY symbol
    ),

    revenue_last12 AS (
      SELECT
        symbol,
        SUM(revenue) AS sum_sales_12m,
        AVG(NULLIF(revenue, 0)) AS avg_sales_12m,
        COUNT(*) FILTER (WHERE revenue > 0) AS month_count_12m
      FROM monthly_base
      WHERE rn <= 12
      GROUP BY symbol
    ),

    margin_from_quarterly AS (
      SELECT DISTINCT ON (symbol)
        symbol,
        net_margin,
        quarter,
        period_end
      FROM quarterly_financials
      WHERE period_end > NOW() - INTERVAL '365 days'
        AND net_margin IS NOT NULL
        AND net_margin > 0
        AND net_margin < 1          -- حاشیه بالای ۱۰۰٪ غیرمعتبر
      ORDER BY symbol, period_end DESC
    ),

    margin_from_monthly AS (
      SELECT
        symbol,
        CASE
          WHEN sum_sales > 0 AND month_count_with_service > 0
            THEN sum_gross / sum_sales
          ELSE NULL
        END AS margin
      FROM revenue_last3
    ),

    recent_price AS (
      SELECT DISTINCT ON (symbol) symbol, last_price
      FROM prices
      ORDER BY symbol, timestamp DESC
    )

    SELECT
      sp.symbol,
      sp.sector,
      sp2.last_price,
      sp.shares_outstanding,
      sp.is_bank,
      sp.is_insurance,
      sp.is_holding_company,
      r3.sum_sales,
      r3.avg_sales,
      r3.month_count::int,
      r3.month_count_with_service::int,
      r12.sum_sales_12m,
      r12.avg_sales_12m,
      r12.month_count_12m::int,
      lq.net_margin AS quarterly_margin,
      lq.quarter,
      lq2.margin AS monthly_gross_margin,
      lq2.margin IS NOT NULL AS margin_from_monthly,
      (lq.net_margin IS NOT NULL) AS margin_from_quarterly
    FROM stocks sp
    JOIN recent_price sp2 ON sp2.symbol = sp.symbol
    LEFT JOIN revenue_last3 r3 ON r3.symbol = sp.symbol
    LEFT JOIN revenue_last12 r12 ON r12.symbol = sp.symbol
    LEFT JOIN margin_from_quarterly lq ON lq.symbol = sp.symbol
    LEFT JOIN margin_from_monthly lq2 ON lq2.symbol = sp.symbol
  `;

  let count = 0;

  for (const r of rows) {
    const shares = Number(r.shares_outstanding ?? 0);
    const price = Number(r.last_price ?? 0);
    const sumSales = Number(r.sum_sales ?? 0);
    const avgSales = Number(r.avg_sales ?? 0);
    const monthCount = Number(r.month_count ?? 0);
    const monthCountWithService = Number(r.month_count_with_service ?? 0);
    const sumSales12 = Number(r.sum_sales_12m ?? 0);
    const avgSales12 = Number(r.avg_sales_12m ?? 0);
    const monthCount12 = Number(r.month_count_12m ?? 0);
    const isBank = Boolean(r.is_bank);
    const isInsurance = Boolean(r.is_insurance);
    const isHolding = Boolean(r.is_holding_company);
    const sector = String(r.sector ?? "");

    const quarterlyMargin =
      r.quarterly_margin == null ? null : Number(r.quarterly_margin);

    const monthlyGrossMargin =
      r.monthly_gross_margin == null ? null : Number(r.monthly_gross_margin);

    const hasFullQuarter = monthCount >= 3;
    const quarterlySales = hasFullQuarter ? sumSales : avgSales * 3;
    const yearlySales = quarterlySales * 4;

    const hasFullYear = monthCount12 >= 12;
    const yearlySales12 = hasFullYear ? sumSales12 : avgSales12 * 12;

    // ---------- پیش‌فرض بخشی (sector default) ----------
    // حاشیه سود محافظه‌کارانه بر اساس صنعت
    let sectorDefault: number | null = null;
    if (isBank) sectorDefault = 0.15;
    else if (isInsurance) sectorDefault = 0.08;
    else if (isHolding) sectorDefault = 0.05;
    else if (sector.includes("زراعت") || sector.includes("کشاورزی"))
      sectorDefault = 0.06; // زراعت و خدمات وابسته
    else if (sector.includes("غذایی")) sectorDefault = 0.07;
    else if (sector.includes("دارو")) sectorDefault = 0.1;
    else if (sector.includes("فلز") || sector.includes("معدن"))
      sectorDefault = 0.12;
    else if (sector.includes("پتروشیمی") || sector.includes("شیمیایی"))
      sectorDefault = 0.14;
    else if (sector.includes("سیمان")) sectorDefault = 0.1;
    else if (sector.includes("خودرو")) sectorDefault = 0.05;
    else if (sector.includes("ساختمان")) sectorDefault = 0.06;

    let margin = 0;
    let marginSource = "بدون حاشیه سود معتبر — P/E محاسبه نشد";
    let marginIsAssumed = false;
    let marginIsApproximate = false;

    // ---------- انتخاب حاشیه ----------
    // ۱) حاشیه سود خالص از گزارش فصلی (معتبرترین)
    if (quarterlyMargin != null && quarterlyMargin > 0 && quarterlyMargin < 1) {
      const qLabel =
        Number(r.quarter) === 3
          ? "۹ ماهه"
          : Number(r.quarter) === 4
            ? "۱۲ ماهه"
            : Number(r.quarter) === 2
              ? "۶ ماهه"
              : "۳ ماهه";
      margin = quarterlyMargin;
      marginSource = `حاشیه سود آخرین فصل (${qLabel}) (${(margin * 100).toFixed(1)}٪)`;
    }
    // ۲) حاشیه سود ناخالص از گزارش ماهانه — فقط اگر service واقعاً موجود باشد
    else if (
      monthlyGrossMargin != null &&
      monthlyGrossMargin > 0 &&
      monthlyGrossMargin < 0.85 &&
      monthCountWithService > 0
    ) {
      margin = monthlyGrossMargin;
      marginSource = `حاشیه سود ناخالص از گزارش فعالیت ماهانه (${(margin * 100).toFixed(1)}٪) ⚠️ برآورد`;
      marginIsApproximate = true;
    }
    // ۳) پیش‌فرض بخشی
    else if (sectorDefault != null) {
      margin = sectorDefault;
      marginIsAssumed = true;
      const sectorLabel = isBank
        ? "بانکی"
        : isInsurance
          ? "بیمه‌ای"
          : isHolding
            ? "هلدینگی"
            : sector || "بخشی";
      marginSource = `حاشیه سود پیش‌فرض ${sectorLabel} (${(margin * 100).toFixed(1)}٪) ⚠️ برآورد`;
    }

    // ---------- محاسبه P/E ----------
    let eps: number | null = null;
    let pe: number | null = null;
    let pe12: number | null = null;
    let eps12: number | null = null;
    let confidence = "non_calculable";
    let confidenceScore = 0;
    let disclaimer = "";

    if (price > 0 && shares > 0 && quarterlySales > 0 && margin > 0) {
      const annualSales = yearlySales * 1_000_000;
      eps = (annualSales * margin) / shares;

      if (eps > 0) {
        pe = price / eps;

        confidenceScore = monthCount >= 3 ? 0.75 : monthCount === 2 ? 0.5 : 0.3;
        confidence =
          confidenceScore >= 0.75
            ? "high"
            : confidenceScore >= 0.4
              ? "medium"
              : "low";

        if (marginIsApproximate) {
          confidenceScore = Math.max(0.25, confidenceScore - 0.25);
        }
        if (marginIsAssumed) {
          confidenceScore = Math.max(0.2, confidenceScore - 0.35);
        }
        confidence =
          confidenceScore >= 0.75
            ? "high"
            : confidenceScore >= 0.4
              ? "medium"
              : "low";

        if (shares > 0 && yearlySales12 > 0) {
          eps12 = (yearlySales12 * 1_000_000 * margin) / shares;
          if (eps12 > 0) pe12 = price / eps12;
        }

        const salesNote = hasFullQuarter
          ? `فروش ${monthCount} ماه اخیر (${Math.round(quarterlySales).toLocaleString()} میلیون ریال × ۴)`
          : `فروش ${monthCount} ماه اخیر (میانگین × ۳ × ۴)`;

        let basisNote = "";
        if (pe12 != null && pe12 > 0) {
          const divergence = Math.abs(pe - pe12) / pe12;
          basisNote = ` مبنای ۱۲ ماه اخیر: P/E ≈ ${pe12.toFixed(2)}. فاصله دو مبنا ${(divergence * 100).toFixed(0)}٪ است.`;
        }

        disclaimer = `برآورد بر اساس ${salesNote} و ${marginSource}.${basisNote} ⚠️ این یک برآورد است، نه پیش‌بینی قیمت.`;
      }
    } else {
      disclaimer =
        "داده‌های قیمت، سهام یا فروش ماهانه کافی موجود نیست یا حاشیه سود معتبر یافت نشد.";
    }

    const method =
      pe == null
        ? "unavailable"
        : marginIsApproximate
          ? "last3m_anchored_gross_margin"
          : marginIsAssumed
            ? "last3m_annualised_assumed_margin"
            : hasFullQuarter
              ? "last3m_annualised"
              : "last3m_avg_annualised";

    await sql`
      INSERT INTO forward_pe (
        symbol, calculated_at, estimated_annual_eps, forward_pe,
        confidence, confidence_score, method, margin_used, disclaimer,
        calculation_json
      ) VALUES (
        ${r.symbol}, NOW(), ${eps}, ${pe}, ${confidence}, ${confidenceScore},
        ${method}, ${margin}, ${disclaimer},
        ${JSON.stringify({
          basis: "last_3_months_annualised_x4",
          quarterlySales,
          yearlySales,
          hasFullQuarter,
          monthCount,
          monthCountWithService,
          yearlySales12,
          hasFullYear,
          monthCount12,
          pe12,
          eps12,
          quarterlyMargin,
          monthlyGrossMarginRaw: monthlyGrossMargin,
          sectorDefault,
          marginSource,
        })}::jsonb
      )
    `;

    // فقط آخرین محاسبه برای هر نماد نگه داشته شود
    await sql`
      DELETE FROM forward_pe
      WHERE ctid IN (
        SELECT ctid FROM (
          SELECT ctid,
                 ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY calculated_at DESC) AS rn
          FROM forward_pe
        ) p
        WHERE p.rn > 1
      )
    `;

    count += margin > 0 && pe != null ? 1 : 0;
  }

  return count;
}

// ═══════════════════════════════════════════════════════════════
// Phase 5: Refresh rankings
// ═══════════════════════════════════════════════════════════════

export async function refreshRankings(sql: PostgresDb): Promise<void> {
  await sql`REFRESH MATERIALIZED VIEW stock_rankings`;
}

// ═══════════════════════════════════════════════════════════════
// Phase 0: FX rates
// ═══════════════════════════════════════════════════════════════

export async function syncFxRates(sql: PostgresDb): Promise<number> {
  let rate: FxRate;
  try {
    rate = await fetchFxRate();
  } catch (e: unknown) {
    console.error(`  ✗ FX fetch failed: ${(e as Error).message.slice(0, 120)}`);
    return 0;
  }

  await sql`
    INSERT INTO fx_rates (rate_date, rate_toman, rate_rial, sources, quality, readings, fetched_at)
    VALUES (
      CURRENT_DATE, ${rate.rateToman}, ${rate.rateRial},
      ${Array.from(rate.sources)}::text[], ${rate.quality},
      ${JSON.stringify(rate.readings)}::jsonb, NOW()
    )
    ON CONFLICT (rate_date) DO UPDATE SET
      rate_toman = EXCLUDED.rate_toman,
      rate_rial  = EXCLUDED.rate_rial,
      sources    = EXCLUDED.sources,
      quality    = EXCLUDED.quality,
      readings   = EXCLUDED.readings,
      fetched_at = NOW()
  `;

  console.log(
    `  ✓ FX rate: ${rate.rateToman.toLocaleString()} Toman = ${rate.rateRial.toLocaleString()} Rial/USD (${rate.quality}, sources: ${rate.sources.join(", ")})`,
  );
  return 1;
}

export async function getFxRateForDate(
  sql: PostgresDb,
  dateStr: string | null,
): Promise<FxRate | null> {
  const targetDate = dateStr ?? new Date().toISOString().slice(0, 10);

  const rows = await sql<
    Array<{
      rate_toman: number;
      rate_rial: number;
      sources: string[];
      quality: string;
      readings: Record<string, unknown>;
      fetched_at: Date;
    }>
  >`
    SELECT rate_toman, rate_rial, sources, quality, readings, fetched_at
    FROM fx_rates
    WHERE rate_date <= ${targetDate}::date
    ORDER BY rate_date DESC
    LIMIT 1
  `;

  let r: any = rows[0];
  if (!r) {
    const f = await sql<any[]>`
      SELECT rate_toman, rate_rial, sources, quality, readings, fetched_at
      FROM fx_rates
      WHERE rate_date >= ${targetDate}::date
      ORDER BY rate_date ASC
      LIMIT 1
    `;
    if (f.length === 0) return null;
    r = f[0];
  }

  return {
    rateToman: Number(r.rate_toman),
    rateRial: Number(r.rate_rial),
    sources: (r.sources as FxSource[]) ?? [],
    quality: (r.quality as FxQualityStatus) ?? "fallback",
    readings: r.readings as Partial<Record<FxSource, number>>,
    fetchedAt: r.fetched_at.toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════
// Phase 1b: Market-cap history
// ═══════════════════════════════════════════════════════════════

export async function syncMarketCapHistory(sql: PostgresDb): Promise<number> {
  const snapshots = await sql<
    Array<{
      symbol: string;
      date: Date;
      last_price: number;
      shares_outstanding: number | null;
    }>
  >`
    WITH daily_last AS (
      SELECT DISTINCT ON (symbol, DATE(timestamp))
        symbol, DATE(timestamp) AS date, last_price
      FROM prices
      ORDER BY symbol, DATE(timestamp), timestamp DESC
    )
    SELECT d.symbol, d.date, d.last_price, s.shares_outstanding
    FROM daily_last d
    JOIN stocks s ON s.symbol = d.symbol
    WHERE s.shares_outstanding IS NOT NULL
      AND d.last_price IS NOT NULL AND d.last_price > 0
    ORDER BY d.date ASC, d.symbol
  `;

  let count = 0;
  for (const row of snapshots) {
    const price = Number(row.last_price);
    const shares = Number(row.shares_outstanding!);
    const mcapRial = price * shares;
    const dateStr = row.date.toISOString().slice(0, 10);

    const fxRate = await getFxRateForDate(sql, dateStr).catch(() => null);
    const rateRial = fxRate?.rateRial ?? null;
    const mcapUsd = rateRial && rateRial > 0 ? mcapRial / rateRial : null;

    await sql`
      INSERT INTO market_cap_history (symbol, date, price_rial, shares_count, mcap_rial, mcap_usd,
                                      fx_rate_rial, fx_quality, fx_sources, source)
      VALUES (
        ${row.symbol}, ${dateStr}::date, ${price}, ${shares}, ${mcapRial}, ${mcapUsd},
        ${rateRial}, ${fxRate?.quality ?? null},
        ${fxRate ? Array.from(fxRate.sources) : null},
        'tsetmc_fx'
      )
      ON CONFLICT (symbol, date) DO UPDATE SET
        price_rial   = EXCLUDED.price_rial,
        mcap_rial    = EXCLUDED.mcap_rial,
        mcap_usd     = EXCLUDED.mcap_usd,
        fx_rate_rial = EXCLUDED.fx_rate_rial,
        fx_quality   = EXCLUDED.fx_quality,
        fx_sources   = EXCLUDED.fx_sources,
        source       = EXCLUDED.source
    `;
    count++;
  }

  console.log(`  ✓ ${count} market-cap history points stored`);
  return count;
}

export async function fetchCurrentPrices(): Promise<ResolvedInstrument[]> {
  const out: ResolvedInstrument[] = [];
  for (const { sym, name } of WATCHLIST) {
    try {
      const snap = await tsetmc.resolveSymbol(sym, name ?? null);
      if (snap) out.push(snap);
    } catch (e: unknown) {
      console.error(
        `  [${sym}] ✗ ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`,
      );
    }
    await sleep(DELAY_MS);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// Archive/backfill
// ═══════════════════════════════════════════════════════════════

export interface ArchiveResult {
  symbol: string;
  lettersFound: number;
  reportsParsed: number;
  rowsUpserted: number;
  /** Months already in the DB (within the 7-day dedup window) — not fetched. */
  skippedKnown?: number;
  /** Months outside the requested Jalali from/to window — not fetched. */
  skippedOutOfRange?: number;
  errors: string[];
}

/** Parse a "YYYY/MM/DD" (or YYYY-MM-DD) Jalali string into an ISO date. */
function parseJalaliBound(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!m) return null;
  return toIsoDate(jalaliToGregorian(+m[1]!, +m[2]!, +m[3]!));
}

export async function ingestArchiveForSymbol(
  sql: PostgresDb,
  symbol: string,
  fromJalali: string,
  toJalali: string,
): Promise<Omit<ArchiveResult, "symbol">> {
  const errors: string[] = [];
  const wl = WATCHLIST_BY_SYM.get(symbol);
  await sql`
    INSERT INTO stocks (
      symbol, name, sector,
      is_bank, is_insurance, is_holding_company,
      updated_at
    )
    VALUES (
      ${symbol},
      ${wl?.name ?? symbol},
      ${null},
      ${wl?.type === "bank"},
      ${wl?.type === "insurance"},
      ${wl?.type === "holding"},
      NOW()
    )
    ON CONFLICT (symbol) DO NOTHING
  `;

  const allLetters: CodalLetter[] = [];
  for (let page = 1; page <= 20; page++) {
    if (isCodalCoolingDown()) {
      console.warn(
        `  [${symbol}] ⚠ stopping at page ${page} — ${codalThrottleStatus()}`,
      );
      break;
    }
    const letters = await searchLetters(symbol, { PageNumber: String(page) });
    if (letters.length === 0) break;
    allLetters.push(...letters);
    if (letters.length < 20) break;
  }
  const monthly = filterMonthlySalesLetters(allLetters);

  // Dedup: which month_ends do we already have (ingested within 7 days)?
  // Without this, re-running an archive re-downloads ~100 report pages and
  // re-upserts them — exact same complaint as Phase 2, and much worse for a
  // backfill since reportsParsed never shrinks on retries.
  const knownRows = await sql<{ month_end: Date | string }[]>`
    SELECT month_end FROM monthly_sales
    WHERE symbol = ${symbol}
      AND fetched_at > NOW() - INTERVAL '7 days'
  `;
  const knownMonths = new Set(
    knownRows.map((r) =>
      r.month_end instanceof Date
        ? r.month_end.toISOString().slice(0, 10)
        : String(r.month_end).slice(0, 10),
    ),
  );

  // `from`/`to` were previously ignored (params were literally `_fromJalali`),
  // so every archive run backfilled the entire history — a 1405-only request
  // still fetched ۱۴۰۱ and ۱۳۹۷ reports. Resolve the window once here and
  // filter letters by their period end BEFORE downloading report HTML.
  const fromIso = parseJalaliBound(fromJalali);
  const toIso = parseJalaliBound(toJalali);
  let skippedOutOfRange = 0;

  let reportsParsed = 0;
  let rowsUpserted = 0;
  let skippedKnown = 0;
  const fx = await resolveFxContext(sql);

  for (const letter of monthly) {
    if (isCodalCoolingDown()) {
      console.warn(
        `  [${symbol}] ⚠ stopping report fetch — ${codalThrottleStatus()}`,
      );
      break;
    }
    const period = extractJalaliPeriodEnd(letter.title);
    if (period) {
      const monthEnd = toIsoDate(
        jalaliToGregorian(period.jy, period.jm, period.jd),
      );
      // Outside the requested Jalali window (or already in the DB within the
      // 7-day dedup window) → never download this report.
      if ((fromIso && monthEnd < fromIso) || (toIso && monthEnd > toIso)) {
        skippedOutOfRange++;
        continue;
      }
      if (knownMonths.has(monthEnd)) {
        skippedKnown++;
        continue;
      }
    }
    try {
      const html = await fetchReportHtml(letter.url);
      const full = extractMonthlySalesFull(
        html,
        letter.title,
        letter.url,
        letter.publishDateTime,
      );
      if (!full) continue;
      reportsParsed++;

      const monthEnd = toIsoDate(
        jalaliToGregorian(
          full.periodEnd.jy,
          full.periodEnd.jm,
          full.periodEnd.jd,
        ),
      );
      const d: any = full.detail ?? {};

      await upsertMonthlySalesRow(sql, fx, {
        symbol,
        monthEnd,
        salesAmount: full.total,
        reportUrl: full.url,
        detail: full.detail ?? null,
        ytdTotal: num(full.ytdTotal),
        ytdPriorYear: num(full.ytdPriorYearTotal),
        domesticRial: num(d.domesticMonthly),
        exportRial: num(d.exportMonthly),
        serviceRial: num(d.serviceMonthly),
      });
      rowsUpserted++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${letter.title.slice(0, 80)}: ${msg.slice(0, 120)}`);
    }
  }

  if (skippedKnown) {
    console.log(
      `  [${symbol}] ↷ ${skippedKnown} month(s) already in DB — skipped (dedup)`,
    );
  }
  if (skippedOutOfRange) {
    console.log(
      `  [${symbol}] ↷ ${skippedOutOfRange} month(s) outside ${fromJalali}–${toJalali} — skipped`,
    );
  }

  return {
    lettersFound: monthly.length,
    reportsParsed,
    rowsUpserted,
    skippedKnown,
    skippedOutOfRange,
    errors,
  };
}

export async function ingestArchiveForSymbols(
  sql: PostgresDb,
  symbols: string[],
  fromJalali: string,
  toJalali: string,
): Promise<ArchiveResult[]> {
  const results: ArchiveResult[] = [];
  for (const symbol of symbols) {
    const res = await ingestArchiveForSymbol(sql, symbol, fromJalali, toJalali);
    results.push({ symbol, ...res });
    await sleep(DELAY_MS);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// Full pipeline
// ═══════════════════════════════════════════════════════════════
export async function runFullIngest(
  sql: PostgresDb,
  minYear?: number,
  maxYear?: number,
  maxMonthEnd?: Date,
): Promise<{
  fx: number;
  stocks: number;
  prices: number;
  mcap: number;
  sales: number;
  quarterly: number;
  pe: number;
}> {
  try {
    console.log("=== Phase 0: FX rate (Wallex + Nobitex) ===");
    const fxC = await syncFxRates(sql);

    console.log("\n=== Phase 1: TSETMC symbols + prices ===");
    const snapshots = await scrapeAllSymbols();
    const stocksCount = await upsertStocks(sql, snapshots);
    const priceCount = await insertPrices(sql, snapshots);

    console.log("\n=== Phase 1b: Market-cap history ===");
    const mcapCount = await syncMarketCapHistory(sql);

    const syms = snapshots.map((s) => s.symbol);

    console.log("\n=== Phase 2: Codal monthly sales ===");
    const salesCount = await syncMonthlySales(sql, syms, maxMonthEnd);

    console.log("\n=== Phase 3: Codal quarterly financials ===");
    const quarterlyCount = await syncQuarterlyFinancials(
      sql,
      syms,
      minYear,
      maxYear,
    );

    console.log("\n=== Phase 4: Forward P/E ===");
    const peCount = await recomputeForwardPe(sql);

    console.log("\n=== Phase 5: Rankings ===");
    await refreshRankings(sql);

    return {
      fx: fxC,
      stocks: stocksCount,
      prices: priceCount,
      mcap: mcapCount,
      sales: salesCount,
      quarterly: quarterlyCount,
      pe: peCount,
    };
  } finally {
    await closeBrowser();
  }
}

// ═══════════════════════════════════════════════════════════════
// Individual remote ingestion phases (for standalone calls)
// ═══════════════════════════════════════════════════════════════

/** Phase 1: TSETMC symbols + prices → Batch 1b market-cap history. */
export async function runPricesOnly(
  sql: PostgresDb,
): Promise<{ stocks: number; prices: number; mcap: number }> {
  console.log("\n=== Phase 1: TSETMC symbols + prices ===");
  const snapshots = await scrapeAllSymbols();
  const stocksCount = await upsertStocks(sql, snapshots);
  const priceCount = await insertPrices(sql, snapshots);

  console.log("\n=== Phase 1b: Market-cap history ===");
  const mcapCount = await syncMarketCapHistory(sql);

  return { stocks: stocksCount, prices: priceCount, mcap: mcapCount };
}

/** Phase 2: Codal monthly sales. `full=true` backfills history; default = latest month only. */
export async function runMonthlySalesOnly(
  sql: PostgresDb,
  full = false,
): Promise<number> {
  const syms = WATCHLIST.map((w) => w.sym);
  console.log(
    `\n=== Phase 2: Codal monthly sales (${full ? "full backfill" : "latest month only"}) ===`,
  );
  const count = full
    ? await syncMonthlySales(sql, syms, undefined)
    : await syncLatestMonthlySales(sql, syms);
  console.log(`  [sales] upserted ${count} monthly sales records`);
  return count;
}

/** Phase 3: Codal quarterly financials. Accepts year/warded */
export async function runQuarterlyOnly(
  sql: PostgresDb,
  minYear?: number,
  maxYear?: number,
): Promise<number> {
  const syms = WATCHLIST.map((w) => w.sym);
  console.log("\n=== Phase 3: Codal quarterly financials ===");
  const count = await syncQuarterlyFinancials(sql, syms, minYear, maxYear);
  console.log(`  [quarterly] upserted ${count} quarterly financial records`);
  return count;
}

/** Phase 5: Recalculate rankings. */
export async function runRankingsOnly(sql: PostgresDb): Promise<void> {
  console.log("\n=== Phase 5: Rankings ===");
  await refreshRankings(sql);
  console.log("  [rankings] completed");
}
