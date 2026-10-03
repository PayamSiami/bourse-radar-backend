/**
 * Core domain types for TSE stock data.
 * Every number from TSETMC or Codal.ir is tagged with a `source` and `fetchedAt`
 * so that downstream services can assess freshness and confidence.
 */

export type Sector =
  | "فلزات و معادن"           // Metals & Mining
  | "دارویی"                   // Pharmaceuticals
  | "بانکی"                    // Banking
  | "بیمه‌ای"                  // Insurance
  | "حمل و نقل"               // Transportation
  | "پتروشیمی"                 // Petrochemicals
  | "فناوری اطلاعات"          // Technology
  | "سرمایه‌گذاری"            // Investment (holding companies)
  | "غذایی"                    // Food & Beverage
  | "ساخت و ساز"              // Construction
  | "خردمهندسی"                // Engineering
  | "کشاورزی"                 // Agriculture
  | "دام و دامداری";          // Livestock

export type InstrumentClass = "سهام" | "اوراق" | "صندوق";

/** Raw price tick from TSETMC cdn API */
export interface StockPrice {
  symbol: string;
  isin: string;              // International Securities Identification Number
  name: string;
  nameEn: string;
  sector: Sector | null;
  instrumentalClass: InstrumentClass;
  lastPrice: number | null;  // Latest closing price (IRR)
  priceChange: number | null;
  priceChangePercent: number | null;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  closePrice: number | null;
  volume: bigint | null;     // Shares traded today
  value: number | null;      // Trade value (IRR)
  marketCap: number | null;  // Estimated market cap (IRR)
  sharesOutstanding: bigint | null;
  timestamp: Date;
  isStale: boolean;          // true if older than PRICE_MAX_AGE_SECONDS
}

/** Fundamental snapshot that may come from TSETMC or be enriched via Codal */
export interface StockFundamentals {
  symbol: string;
  /**
   * Current P/E (trailing 12-month).
   * Source: TSETMC `cdnPe` field.
   * Null when EPS is zero/negative or data is unavailable.
   */
  pe: number | null;
  peRank: number | null;         // Percentile rank within sector (0-100)
  peTimestamp: Date | null;
  eps: number | null;            // Last annual EPS
  epsYear: number | null;        // Fiscal year of EPS

  /**
   * Book value per share.
   * Used as fallback denominator for banks/insurers.
   */
  bookValuePerShare: number | null;

  /**
   * Industry classification for margin fallback.
   */
  industryGroup: string;         // e.g. "معدن", "بانکی"
  isHoldingCompany: boolean;
  isBank: boolean;
  isInsurance: boolean;
}

/** Standardized symbol-level data returned by `fetch_stock_data` */
export interface StockData {
  symbol: string;
  name: string;
  nameEn: string;
  sector: Sector | null;
  price: StockPrice | null;
  fundamentals: StockFundamentals | null;
  monthlySales: MonthlySalesReport[];
  quarterlyFinancials: QuarterlyFinancials | null;
  dataFreshness: {
    priceAgeSeconds: number | null;
    salesAgeDays: number | null;
    quarterlyAgeDays: number | null;
  };
}

export interface MonthlySalesReport {
  symbol: string;
  /** End of the Iranian financial month (e.g. 1402/04/30) */
  monthEndDate: Date;
  /** Sales amount in millions of IRR as reported */
  salesAmount: number;
  isEstimated: boolean;
  sourceUrl: string;
  fetchedAt: Date;
}

export interface QuarterlyFinancials {
  symbol: string;
  year: number;          // Iranian fiscal year, e.g. 1402
  quarter: number;       // 1–4
  periodStart: Date;
  periodEnd: Date;

  revenue: number | null;      // میلیارد ریال
  netProfit: number | null;    // سود خالص
  netMargin: number | null;    // به درصد (netProfit / revenue)
  grossMargin: number | null;   // به درصد
  ebitda: number | null;
  ebitdaMargin: number | null;
  totalAssets: number | null;   // میلیارد ریال
  totalLiabilities: number | null;
  shareholdersEquity: number | null;
  sharesOutstanding: bigint | null;
  sourceUrl: string;
  fetchedAt: Date;
}

/** A fully calculated Forward P/E record */
export interface ForwardPERecord {
  symbol: string;
  name: string;
  timestamp: Date;

  /** The stock price used as numerator */
  currentPrice: number | null;
  estimatedAnnualEps: number | null;

  /** price / estimatedAnnualEps, null when EPS ≤ 0 or no data */
  forwardPe: number | null;

  /** Qualitative confidence label */
  confidence: "high" | "medium" | "low" | "non_calculable";

  /** Numeric confidence score 0–1 (for ranking) */
  confidenceScore: number;

  /** How the EPS was estimated */
  method: ForwardPEMethod;

  /** Source metadata for traceability */
  sources: {
    salesReportsUsed: number;
    salesLastFetched: Date | null;
    quarterlyFiscalYear: number | null;
    quarterlyFetched: Date | null;
    netMarginSource: "quarterly" | "industry_avg" | "sector_avg" | "default";
    industryAvgMargin: number | null;
    sharesOutstanding: bigint | null;
  };

  /** Free-form explanation of how the estimate was derived */
  calculationDetails: Record<string, unknown>;

  /** Explicit disclosure string shown to end-users */
  disclaimer: string;
}

export type ForwardPEMethod =
  | "monthly_sales_net_margin"
  | "monthly_sales_industry_margin"
  | "ttm_eps_annualized"
  | "non_calculable";

/** Ranking weight configuration (user can adjust) */
export interface RankingWeights {
  inverseForwardPe: number;    // 0–1
  confidenceScore: number;     // 0–1
  liquidityScore: number;      // 0–1 (log volume percentile)
  marketCapScore: number;      // 0–1 (normalized, favors mid-cap)
  priceStability: number;      // 0–1 (lower volatility = higher score)
}
