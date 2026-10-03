/**
 * Bourse Radar — Forward P/E Estimation Engine (TypeScript Reference)
 * Tehran Stock Exchange (TSE) — Forward P/E estimation from monthly sales
 * reports and quarterly financials.
 *
 * Algorithm:
 *   Estimated_Annual_EPS = (Trailing_3M_Sales_Avg × 12 × Net_Margin) / Shares_Outstanding
 *   Forward_P/E         = Current_Price / Estimated_Annual_EPS
 *
 * Data sources:
 *   [citation:14] Monthly sales reports (فروش ماهانه) from Codal.ir
 *   [citation:2]  Quarterly financials from Codal.ir
 *   [citation:1]  Stock data (price, shares, EPS) from pytse-client / cdn.tsetmc.com
 *   [citation:4]  Unofficial API endpoints at cdn.tsetmc.com and webgw.tse.ir
 *
 * Key constraint:
 *   EPS forecasts are NOT mandatory since 2018 → Forward P/E must be ESTIMATED.
 *   If estimation is not possible, return "non_calculable" — never a fabricated number.
 */

import { z } from "zod";

// ──────────────── Zod Schemas ────────────────────────────

export const ConfidenceSchema = z.enum(["high", "medium", "low", "non_calculable"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const MonthlySalesReportSchema = z.object({
  monthEnd: z.date(),
  salesAmountMillionsIRR: z.number().positive(),    // فروش ماهانه (میلیون ریال)
  isEstimated: z.boolean().default(false),           // برآوردی vs. واقعی
  sourceUrl: z.string().url(),
  fetchedAt: z.date().default(() => new Date()),
});

export const QuarterlyFinancialsSchema = z.object({
  fiscalYear: z.number().int(),
  quarter: z.number().int().min(1).max(4),
  periodStart: z.date(),
  periodEnd: z.date(),
  revenueMillionsIRR: z.number().nullable(),
  netProfitMillionsIRR: z.number().nullable(),
  netMargin: z.number().nullable(),                   // fraction
  extraordinaryIncomeMillionsIRR: z.number().optional(),
  extraordinaryExpenseMillionsIRR: z.number().optional(),
  sharesOutstanding: z.number().int().positive().nullable(),
  sourceUrl: z.string().url(),
});

export const StockPriceDataSchema = z.object({
  symbol: z.string().min(1),
  lastPriceIRR: z.number().positive().nullable(),
  sharesOutstanding: z.number().int().positive().nullable(),
  marketCapIRR: z.number().nullable(),
});

// ──────────────── Types ─────────────────────────────────

export type MonthlySalesReport = z.infer<typeof MonthlySalesReportSchema>;
export type QuarterlyFinancials = z.infer<typeof QuarterlyFinancialsSchema>;
export type StockPriceData = z.infer<typeof StockPriceDataSchema>;

export interface ForwardPEResult {
  symbol: string;
  name: string;
  timestamp: string;
  currentPrice: number | null;
  estimatedAnnualEps: number | null;
  forwardPe: number | null;
  confidence: Confidence;
  confidenceScore: number;   // 0–1
  method: string;
  sources: Record<string, unknown>;
  calculationDetails: Record<string, unknown>;
  disclaimer: string;
}

export interface InstrumentFlags {
  isBank?: boolean;
  isInsurance?: boolean;
  isHoldingCompany?: boolean;
  industryGroup?: string;
  industryAvgMargin?: number;   // fraction
  sectorAvgMargin?: number;      // fraction
}

// ──────────────── Constants ─────────────────────────────

const QUARTERLY_FRESH_DAYS = {
  high: 60,
  medium: 120,
  low: 180,
} as const;

const MONTHLY_FRESH_DAYS = 45;

const DEFAULT_MARGIN: Record<string, number> = {
  bank: 0.15,
  insurance: 0.08,
  holding: 0.05,
  general: 0.06,
};

// ──────────────── Forward P/E Estimator ─────────────────

export class ForwardPEEstimator {
  /**
   * Main estimation method.
   *
   * Steps:
   * 1. Collect the 3 most recent monthly sales reports (Codal.ir فروش ماهانه)
   * 2. Annualize: annualized_sales = trailing_3m_avg × 12
   * 3. Determine net margin from quarterly financials (or fallback)
   * 4. estimated_eps = (annualized_sales × 1e6 × margin) / shares
   * 5. forward_pe = current_price / estimated_eps
   * 6. Score confidence based on data freshness & margin source
   */
  estimate(params: {
    symbol: string;
    name: string;
    priceData: StockPriceData;
    monthlyReports: MonthlySalesReport[];
    quarterly: QuarterlyFinancials | null;
    flags: InstrumentFlags;
    today?: Date;
  }): ForwardPEResult {
    const now = new Date();
    const today = params.today ?? new Date();

    const result: ForwardPEResult = {
      symbol: params.symbol,
      name: params.name,
      timestamp: now.toISOString(),
      currentPrice: params.priceData.lastPriceIRR,
      estimatedAnnualEps: null,
      forwardPe: null,
      confidence: "non_calculable",
      confidenceScore: 0,
      method: "non_calculable",
      sources: {},
      calculationDetails: {},
      disclaimer: "",
    };

    // Guard: no current price
    if (!params.priceData.lastPriceIRR) {
      result.disclaimer = "قیمت جاری سهم در دسترس نیست. P/E Forward: غیرقابل محاسبه.";
      return result;
    }

    // ── Step 1: Collect last 3 monthly sales reports ──
    const sorted = [...params.monthlyReports].sort(
      (a, b) => b.monthEnd.getTime() - a.monthEnd.getTime()
    );
    const last3 = sorted.slice(0, 3);

    if (last3.length === 0) {
      result.disclaimer = "گزارش‌های فروش ماهانه موجود نیست. P/E Forward: غیرقابل محاسبه.";
      return result;
    }

    // Freshness check on most recent report
    const mostRecentEnd = last3[0].monthEnd;
    const daysSinceReport = (today.getTime() - mostRecentEnd.getTime()) / (1000 * 3600 * 24);
    if (daysSinceReport > MONTHLY_FRESH_DAYS + 30) {
      result.disclaimer =
        `آخرین گزارش فروش ماهانه ${mostRecentEnd.toISOString().split("T")[0]} ` +
        `است (${Math.round(daysSinceReport)} روز پیش). داده قدیمی است. ` +
        `P/E Forward: غیرقابل محاسبه.`;
      return result;
    }

    const salesAvg = last3.reduce((sum, r) => sum + r.salesAmountMillionsIRR, 0) / last3.length;
    const annualizedSalesMillions = salesAvg * 12;

    // ── Step 2: Determine net margin ──
    const { margin, source: marginSource } = this._determineNetMargin(
      params.quarterly, params.flags, today
    );

    // ── Step 3: Shares outstanding ──
    const shares = params.priceData.sharesOutstanding ?? params.quarterly?.sharesOutstanding;
    if (!shares || shares <= 0) {
      result.disclaimer = "تعداد سهام ثبت‌شده در دسترس نیست. P/E Forward: غیرقابل محاسبه.";
      return result;
    }

    // ── Step 4: Estimated Annual EPS ──
    // annualizedSalesMillions is in millions IRR → multiply by 1e6 for IRR
    const estimatedEps = (annualizedSalesMillions * 1e6 * margin) / shares;
    result.estimatedAnnualEps = Math.round(estimatedEps * 1e4) / 1e4;

    // ── Step 5: Forward P/E ──
    if (estimatedEps <= 0) {
      result.disclaimer = "EPS تخمینی منفی یا صفر است. P/E Forward: غیرقابل محاسبه.";
      result.confidence = "non_calculable";
      return result;
    }

    const forwardPe = params.priceData.lastPriceIRR! / estimatedEps;
    result.forwardPe = Math.round(forwardPe * 100) / 100;

    // ── Step 6: Confidence scoring ──
    const { confidence, score, method } = this._scoreConfidence(
      params.quarterly, last3, marginSource, params.flags, today
    );
    result.confidence = confidence;
    result.confidenceScore = Math.round(score * 1e4) / 1e4;
    result.method = method;

    // ── Sources & details ──
    result.sources = {
      salesReportsUsed: last3.length,
      salesLastFetched: Math.max(...last3.map(r => r.fetchedAt.getTime())),
      quarterlyFiscalYear: params.quarterly?.fiscalYear ?? null,
      quarterlyFetched: params.quarterly?.sourceUrl ?? null,
      netMarginSource: marginSource,
      marginUsed: Math.round(margin * 1e6) / 1e6,
      sharesOutstanding: shares,
      salesAmountsMillions: last3.map(r => r.salesAmountMillionsIRR),
    };
    result.calculationDetails = {
      trailing3mSalesAvgMillions: Math.round(salesAvg * 100) / 100,
      annualizedSalesMillions: Math.round(annualizedSalesMillions * 100) / 100,
      netMargin: Math.round(margin * 1e6) / 1e6,
      sharesOutstanding: shares,
      estimatedEps: Math.round(estimatedEps * 1e4) / 1e4,
      currentPrice: params.priceData.lastPriceIRR,
      forwardPe: Math.round(forwardPe * 100) / 100,
    };
    result.disclaimer = this._buildDisclaimer(
      confidence, marginSource, params.quarterly, last3, today
    );

    return result;
  }

  // ── Step 2: Net margin determination ──────────────

  private _determineNetMargin(
    quarterly: QuarterlyFinancials | null,
    flags: InstrumentFlags,
    today: Date,
  ): { margin: number; source: string } {
    const { isBank, isInsurance, isHoldingCompany, industryAvgMargin, sectorAvgMargin } = flags;

    // 1. Quarterly (fresh enough + has revenue)
    if (quarterly && quarterly.revenueMillionsIRR && quarterly.revenueMillionsIRR > 0) {
      const quarterAge = (today.getTime() - quarterly.periodEnd.getTime()) / (1000 * 3600 * 24);
      if (quarterAge <= QUARTERLY_FRESH_DAYS.low) {
        // Strip non-recurring items
        let adjProfit = quarterly.netProfitMillionsIRR ?? 0;
        if (quarterly.extraordinaryIncomeMillionsIRR) {
          adjProfit -= quarterly.extraordinaryIncomeMillionsIRR;   // remove one-time gains
        }
        if (quarterly.extraordinaryExpenseMillionsIRR) {
          adjProfit += quarterly.extraordinaryExpenseMillionsIRR;   // add back one-time losses
        }
        const margin = adjProfit / quarterly.revenueMillionsIRR;

        if (isBank) return { margin, source: "quarterly_bank_adj" };
        if (isInsurance) return { margin, source: "quarterly_insurance_adj" };
        if (isHoldingCompany) return { margin, source: "quarterly_holding_adj" };
        return { margin, source: "quarterly_adj" };
      }
    }

    // 2. Industry average
    if (industryAvgMargin && industryAvgMargin > 0) {
      return { margin: industryAvgMargin, source: "industry_avg" };
    }

    // 3. Sector average
    if (sectorAvgMargin && sectorAvgMargin > 0) {
      return { margin: sectorAvgMargin, source: "sector_avg" };
    }

    // 4. Instrument-class default
    if (isBank) return { margin: DEFAULT_MARGIN.bank, source: "default_bank" };
    if (isInsurance) return { margin: DEFAULT_MARGIN.insurance, source: "default_insurance" };
    if (isHoldingCompany) return { margin: DEFAULT_MARGIN.holding, source: "default_holding" };
    return { margin: DEFAULT_MARGIN.general, source: "default_general" };
  }

  // ── Step 6: Confidence scoring ────────────────────

  private _scoreConfidence(
    quarterly: QuarterlyFinancials | null,
    monthlyReports: MonthlySalesReport[],
    marginSource: string,
    flags: InstrumentFlags,
    today: Date,
  ): { confidence: Confidence; score: number; method: string } {
    let score = 0;

    // Monthly report count
    if (monthlyReports.length >= 3) score += 0.35;
    else if (monthlyReports.length >= 2) score += 0.25;
    else if (monthlyReports.length >= 1) score += 0.15;

    // Quarterly freshness
    if (quarterly) {
      const age = (today.getTime() - quarterly.periodEnd.getTime()) / (1000 * 3600 * 24);
      if (age <= QUARTERLY_FRESH_DAYS.high) score += 0.35;
      else if (age <= QUARTERLY_FRESH_DAYS.medium) score += 0.25;
      else if (age <= QUARTERLY_FRESH_DAYS.low) score += 0.15;
    }

    // Margin source quality
    if (marginSource.startsWith("quarterly")) score += 0.25;
    else if (marginSource.startsWith("industry")) score += 0.20;
    else if (marginSource.startsWith("sector")) score += 0.15;
    else if (marginSource.startsWith("default")) score += 0.10;

    score = Math.min(score, 1.0);

    // Instrument-class adjustments
    let method = "monthly_sales_net_margin";
    if (flags.isBank) {
      score *= 0.85;
      method = "monthly_sales_net_margin";
    } else if (flags.isInsurance) {
      score *= 0.80;
      method = "monthly_sales_net_margin";
    } else if (flags.isHoldingCompany) {
      score *= 0.75;
      method = "monthly_sales_net_margin";
    }

    // Map score to confidence label
    let confidence: Confidence;
    if (score >= 0.75) confidence = "high";
    else if (score >= 0.40) confidence = "medium";
    else confidence = "low";

    return { confidence, score, method };
  }

  // ── Disclaimers ──────────────────────────────

  private _buildDisclaimer(
    confidence: Confidence,
    marginSource: string,
    quarterly: QuarterlyFinancials | null,
    monthlyReports: MonthlySalesReport[],
    today: Date,
  ): string {
    const parts: string[] = [];
    const n = monthlyReports.length;
    const reportText = n === 1 ? "1 گزارش فروش ماهانه" : `${n} گزارش فروش ماهانه`;

    if (confidence === "high") {
      parts.push(`اعتمادسنجی: بالا — برآورد بر اساس ${reportText} و صورت‌های مالی فصلی اخیر.`);
    } else if (confidence === "medium") {
      parts.push(`اعتمادسنجی: متوسط — برآورد بر اساس ${reportText}، اما حاشیه سود از منبع فرعی به‌دست آمده.`);
    } else {
      parts.push(`اعتمادسنجی: پایین — برآورد با ${reportText} محدود یا منطقه‌ای. نتیجه قابل اعتماد نیست.`);
    }

    if (marginSource.startsWith("default")) {
      parts.push("حاشیه سود از پیش‌فرض صنعتی استفاده شده، نه از صورت مالی شرکت.");
    } else if (marginSource.startsWith("industry")) {
      parts.push("حاشیه سود از میانگین صنعتی استخراج شده است.");
    } else if (marginSource.startsWith("sector")) {
      parts.push("حاشیه سود از میانگین بخشی استخراج شده است.");
    }

    if (quarterly) {
      const age = (today.getTime() - quarterly.periodEnd.getTime()) / (1000 * 3600 * 24);
      if (age > QUARTERLY_FRESH_DAYS.medium) {
        parts.push(`آخرین صورت مالی فصلی ${quarterly.periodEnd.toISOString().split("T")[0]} است — قدیمی است.`);
      }
    }

    if (monthlyReports.some((r) => r.isEstimated)) {
      parts.push("برخی گزارش‌های فروش ماهانه برآوردی (غیردقیق) هستند.");
    }

    parts.push("⚠️ این P/E Forward یک برآورد است، نه یک پیش‌بینی قیمت. برای تصمیم‌گیری سرمایه‌گذاری از مشاوره حرفه‌ای استفاده کنید.");

    return parts.join(" ");
  }
}

// ──────────────── Attractiveness Ranking ────────────────

/**
 * Composite attractiveness score (0–100).
 *
 * Components:
 *   - Inverse Forward P/E (30%): lower P/E → higher score
 *   - Confidence score (25%): higher confidence → higher score
 *   - Liquidity (25%): higher volume → higher score
 *   - Market cap (10%): mid-cap preference
 *   - Price stability (10%): lower volatility → higher score
 */
export function computeAttractivenessScore(params: {
  forwardPe: number | null;
  confidenceScore: number;
  dailyVolume?: number;
  marketCap?: number;
  priceVolatility30d?: number;
}): number | null {
  if (!params.forwardPe || params.forwardPe <= 0) return null;

  // Inverse P/E: P/E 5 → ~0.9, P/E 50 → ~0.1
  const inversePeScore = 1.0 / (1.0 + params.forwardPe / 15.0);

  // Liquidity
  let liquidityScore = 0;
  if (params.dailyVolume && params.dailyVolume > 0) {
    const logVol = Math.log10(params.dailyVolume);
    liquidityScore = Math.min(logVol / 10.0, 1.0);
  }

  // Market cap (mid-cap preference)
  let mcScore = 0.3;
  if (params.marketCap && params.marketCap > 0) {
    const logMc = Math.log10(params.marketCap);
    mcScore = Math.min(logMc / 15.0, 1.0) * 0.7;
    if (logMc >= 13.5 && logMc <= 14.5) mcScore = 0.85;
  }

  // Price stability
  let stabilityScore = 0.5;
  if (params.priceVolatility30d && params.priceVolatility30d > 0) {
    stabilityScore = Math.max(0, 1.0 - params.priceVolatility30d * 3.0);
  }

  const score = (
    inversePeScore * 0.30
    + params.confidenceScore * 0.25
    + liquidityScore * 0.25
    + mcScore * 0.10
    + stabilityScore * 0.10
  ) * 100;

  return Math.round(score * 100) / 100;
}
