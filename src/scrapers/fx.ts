/**
 * FX Rate Scraper — USD/IRR (Rial) and USD/Toman rates
 *
 * reports every market-cap and sales figure in BOTH Rial and
 * USD, carrying an explicit provenance record on each value:
 *
 *   fxRateToman      Toman per 1 USD
 *   fxSources        which exchanges answered: ["nobitex", "wallex"]
 *   fxQualityStatus  "valid"      both sources agreed (within tolerance)
 *                    "fallback"   only one source answered
 *                    "suspicious" sources disagreed beyond tolerance
 *
 * Sources, in the order we try them:
 *   1. Wallex  — https://api.wallex.ir/v1/markets  (symbol `USDTTMN`, Toman)
 *   2. Nobitex — https://api.nobitex.ir/v3/orderbook/USDTIRT
 *
 * NOTE: Nobitex is frequently unreachable (DNS-blocked on some networks and
 * during Iranian connectivity disruption). That is expected and is exactly
 * what the `fallback` quality status is for — we still produce a rate from
 * whichever source answered, and flag the degraded confidence honestly.
 *
 * Rial vs Toman: 1 Toman = 10 Rial, so Rial per USD = Toman per USD × 10.
 * TSETMC and Codal report in Rial, so `rateRial` is the field that matters
 * for every conversion in this codebase; `rateToman` is kept for display
 * because Iranian finance UIs quote the dollar in Toman.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const H = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
};

const WALLEX_MARKETS = "https://api.wallex.ir/v1/markets";
const NOBITEX_HOSTS = [
  "https://api.nobitex.ir",
  "https://api.nobitex.com",
] as const;

const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Relative disagreement above which two sources are considered to contradict
 * each other. Crypto exchanges tracking the same tether can drift by a few
 * tenths of a percent; anything beyond this means one feed is stale.
 */
const SOURCE_DISAGREEMENT_TOLERANCE = 0.02; // 2%

export type FxSource = "nobitex" | "wallex";

export type FxQualityStatus = "valid" | "fallback" | "suspicious";

export interface FxRate {
  /** Toman per 1 USD (what Iranian finance UIs quote) */
  rateToman: number;
  /** Rial per 1 USD (= rateToman × 10). TSETMC/Codal report in Rial. */
  rateRial: number;
  /** Which exchanges answered this fetch */
  sources: FxSource[];
  /** Provenance flag — see FxQualityStatus */
  quality: FxQualityStatus;
  /** Per-source readings, for auditing a `suspicious` verdict */
  readings: Partial<Record<FxSource, number>>;
  /** ISO timestamp of this observation */
  fetchedAt: string;
}

async function getJson(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: H, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════
// Sources
// ═══════════════════════════════════════════════════════════════

/**
 * Wallex publishes a single `/v1/markets` document containing every trading
 * pair. The USD/Toman pair is keyed `USDTTMN` and its last trade price sits
 * at `result.symbols.USDTTMN.stats.lastPrice`.
 *
 * The payload is ~430 KB, so we read it as text and pull out just the one
 * field with a targeted regex instead of JSON.parse-ing the whole document.
 */
export async function fetchWallexRateToman(): Promise<number | null> {
  const data = await getJson(WALLEX_MARKETS);

  const sym =
    data?.result?.symbols?.USDTTMN ??
    data?.result?.symbols?.USDTIRT ??
    data?.result?.symbols?.USDTTMN;

  if (!sym) return null;

  const raw =
    sym?.stats?.lastPrice ??
    sym?.stats?.bidPrice ??
    sym?.stats?.askPrice;

  if (raw === undefined || raw === null || raw === "") return null;

  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;

  return n;
}

/**
 * Nobitex order book for USDT/IRT. `lastTradePrice` is a plain number, but
 * some responses only carry a non-empty `last` side, so fall back to the best
 * mid of bids/asks rather than reporting a missing rate.
 */
export async function fetchNobitexRateToman(): Promise<number | null> {
  let lastErr: unknown;

  for (const host of NOBITEX_HOSTS) {
    try {
      const data = await getJson(`${host}/v3/orderbook/USDTIRT`);
      const book = data?.data ?? data;

      const raw = book?.lastTradePrice;
      if (raw !== undefined && raw !== null && raw !== "") {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return n;
      }

      // Derive a mid-price from the book when there is no last trade.
      const bid = Number(book?.bids?.[0]?.price);
      const ask = Number(book?.asks?.[0]?.price);
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        return (bid + ask) / 2;
      }
    } catch (e) {
      lastErr = e;
      // Try the next host alias.
    }
  }

  if (lastErr) throw lastErr;
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Aggregation
// ═══════════════════════════════════════════════════════════════

/**
 * Query every source concurrently and merge into a single provenance-tagged
 * rate. A source that throws is recorded as absent rather than failing the
 * whole call — a degraded rate with an honest quality flag is more useful
 * than no rate at all.
 */
export async function fetchFxRate(): Promise<FxRate> {
  const [wallex, nobitex] = await Promise.allSettled([
    fetchWallexRateToman(),
    fetchNobitexRateToman(),
  ]);

  const readings: Partial<Record<FxSource, number>> = {};
  const sources: FxSource[] = [];

  if (wallex.status === "fulfilled" && wallex.value) {
    readings.wallex = wallex.value;
    sources.push("wallex");
  }
  if (nobitex.status === "fulfilled" && nobitex.value) {
    readings.nobitex = nobitex.value;
    sources.push("nobitex");
  }

  const values = Object.values(readings).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
  );

  if (values.length === 0) {
    throw new Error(
      "FX: no source returned a usable USD/IRR rate " +
        `(wallex: ${wallex.status}, nobitex: ${nobitex.status})`,
    );
  }

  // Median of whatever answered — resists a single bad print better than a mean.
  const sorted = [...values].sort((a, b) => a - b);
  const rateToman =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;

  let quality: FxQualityStatus;
  if (values.length >= 2) {
    const lo = sorted[0]!;
    const hi = sorted[sorted.length - 1]!;
    const spread = (hi - lo) / lo;
    quality = spread <= SOURCE_DISAGREEMENT_TOLERANCE ? "valid" : "suspicious";
  } else {
    // One source answered: usable, but the caller should not treat it as
    // corroborated. This is the normal state when Nobitex is unreachable.
    quality = "fallback";
  }

  return {
    rateToman,
    rateRial: rateToman * 10,
    sources,
    quality,
    readings,
    fetchedAt: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════
// Conversions
// ═══════════════════════════════════════════════════════════════

/** Rial → USD (IR market cap / sales are quoted in Rial) */
export function rialToUsd(amountRial: number, rateRial: number): number | null {
  if (!Number.isFinite(amountRial) || !Number.isFinite(rateRial) || rateRial <= 0) {
    return null;
  }
  return amountRial / rateRial;
}

/** Rial → Toman (1 Toman = 10 Rial) */
export function rialToToman(amountRial: number): number | null {
  if (!Number.isFinite(amountRial)) return null;
  return amountRial / 10;
}

export const fx = {
  fetchFxRate,
  fetchWallexRateToman,
  fetchNobitexRateToman,
  rialToUsd,
  rialToToman,
};

export default fx;
