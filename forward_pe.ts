/**
 * Bourse Radar — Forward P/E Estimation Engine (TypeScript, v2)
 * Tehran Stock Exchange (TSE)
 */

import { z } from "zod";

// ──────────────── Branded unit types ─────────────────────
// Prevents the classic "millions vs. IRR" mistake at compile time.

declare const IRRBrand: unique symbol;
declare const MillionsIRRBrand: unique symbol;
declare const SharesBrand: unique symbol;

export type IRR = number & { readonly [IRRBrand]: true };
export type MillionsIRR = number & { readonly [MillionsIRRBrand]: true };
export type Shares = number & { readonly [SharesBrand]: true };

export const asIRR = (n: number): IRR => n as IRR;
export const asMillionsIRR = (n: number): MillionsIRR => n as MillionsIRR;
export const asShares = (n: number): Shares => n as Shares;

// ──────────────── Zod Schemas ────────────────────────────

export const ConfidenceSchema = z.enum([
  "high",
  "medium",
  "low",
  "non_calculable",
]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const MonthlySalesReportSchema = z.object({
  /** Gregorian equivalent of the Jalali month-end (documented contract). */
  monthEnd: z.date(),
  salesAmountMillionsIRR: z.number().positive(),
  isEstimated: z.boolean().default(false),
  sourceUrl: z.string().min(1), // see url() note below
  fetchedAt: z.date().default(() => new Date()),
});
export type MonthlySalesReport = z.infer<typeof MonthlySalesReportSchema>;
export type MonthlySalesReportInput = z.input<typeof MonthlySalesReportSchema>;

export const QuarterlyFinancialsSchema = z.object({
  fiscalYear: z.number().int(),
  quarter: z.number().int().min(1).max(4),
  periodStart: z.date(),
  periodEnd: z.date(),
  revenueMillionsIRR: z.number().nullable(),
  netProfitMillionsIRR: z.number().nullable(),
  /** Extraordinary items are stored as *positive magnitudes*; sign is normalized in code. */
  extraordinaryIncomeMillionsIRR: z.number().nonnegative().optional(),
  extraordinaryExpenseMillionsIRR: z.number().nonnegative().optional(),
  sharesOutstanding: z.number().int().positive().nullable(),
  sourceUrl: z.string().min(1),
});
export type QuarterlyFinancials = z.infer<typeof QuarterlyFinancialsSchema>;

export const StockPriceDataSchema = z.object({
  symbol: z.string().min(1),
  lastPriceIRR: z.number().positive().nullable(),
  sharesOutstanding: z.number().int().positive().nullable(),
  marketCapIRR: z.number().nullable(),
  dailyVolumeShares: z.number().nonnegative().nullable().optional(),
  priceVolatility30d: z.number().nonnegative().nullable().optional(), // fraction (0.03 = 3%)
});
export type StockPriceData = z.infer<typeof StockPriceDataSchema>;

// ──────────────── Result type ────────────────────────────

export interface ForwardPEResult {
  symbol: string;
  name: string;
  timestamp: string;
  currentPriceIRR: number | null;
  estimatedAnnualEpsIRR: number | null;
  forwardPe: number | null;
  confidence: Confidence;
  confidenceScore: number;
  method: string;
  reasons: string[]; // structured explanations
  sources: Record<string, unknown>;
  calculationDetails: Record<string, unknown>;
  attractivenessScore: number | null;
  disclaimer: string;
}

export interface InstrumentFlags {
  isBank?: boolean;
  isInsurance?: boolean;
  isHoldingCompany?: boolean;
  industryGroup?: string;
  industryAvgMargin?: number; // fraction
  sectorAvgMargin?: number; // fraction
}

// ──────────────── Policy (no magic numbers) ──────────────

export interface EstimatorPolicy {
  quarterlyFreshDays: { high: number; medium: number; low: number };
  monthlyFreshDays: number;
  /** Max allowed deviation of a month-end from the expected 30.44-day grid, in days. */
  monthGapToleranceDays: number;
  /** Reject margins outside this band as data errors. */
  marginSanityBand: { min: number; max: number };
  /** Shares mismatch ratio above which we flag a capital-change event. */
  sharesMismatchRatio: number;
  defaultMargin: Record<"bank" | "insurance" | "holding" | "general", number>;
  midCapLogBand: { low: number; high: number };
}

export const DEFAULT_POLICY: EstimatorPolicy = {
  quarterlyFreshDays: { high: 60, medium: 120, low: 180 },
  monthlyFreshDays: 45,
  monthGapToleranceDays: 7,
  marginSanityBand: { min: -0.5, max: 1.0 },
  sharesMismatchRatio: 0.02,
  defaultMargin: { bank: 0.15, insurance: 0.08, holding: 0.05, general: 0.06 },
  midCapLogBand: { low: 13.5, high: 14.5 },
};

const MS_PER_DAY = 1000 * 3600 * 24;
const AVG_MONTH_DAYS = 30.44;

// ──────────────── Estimator ──────────────────────────────

export class ForwardPEEstimator {
  constructor(private readonly policy: EstimatorPolicy = DEFAULT_POLICY) {}

  estimate(params: {
    symbol: string;
    name: string;
    priceData: StockPriceData;
    monthlyReports: MonthlySalesReport[];
    quarterly: QuarterlyFinancials | null;
    flags: InstrumentFlags;
    today?: Date;
  }): ForwardPEResult {
    const today = params.today ?? new Date();
    const timestamp = today.toISOString();

    const base: ForwardPEResult = {
      symbol: params.symbol,
      name: params.name,
      timestamp,
      currentPriceIRR: params.priceData.lastPriceIRR,
      estimatedAnnualEpsIRR: null,
      forwardPe: null,
      confidence: "non_calculable",
      confidenceScore: 0,
      method: "non_calculable",
      reasons: [],
      sources: {},
      calculationDetails: {},
      attractivenessScore: null,
      disclaimer: "",
    };

    try {
      return this._estimate(base, params, today);
    } catch (err) {
      base.reasons.push(`internal_error: ${(err as Error).message}`);
      base.disclaimer =
        "خطای داخلی در محاسبه P/E Forward. نتیجه: غیرقابل محاسبه.";
      return base;
    }
  }

  private _estimate(
    result: ForwardPEResult,
    params: Parameters<ForwardPEEstimator["estimate"]>[0],
    today: Date,
  ): ForwardPEResult {
    // ── Guard: price ──
    const price = params.priceData.lastPriceIRR;
    if (!price || price <= 0) {
      return this._fail(
        result,
        "missing_price",
        "قیمت جاری سهم در دسترس نیست. P/E Forward: غیرقابل محاسبه.",
      );
    }

    // ── Step 1: trailing 3 monthly reports ──
    const sorted = [...params.monthlyReports].sort(
      (a, b) => b.monthEnd.getTime() - a.monthEnd.getTime(),
    );
    const last3 = sorted.slice(0, 3);

    if (last3.length === 0) {
      return this._fail(
        result,
        "no_monthly_reports",
        "گزارش‌های فروش ماهانه موجود نیست. P/E Forward: غیرقابل محاسبه.",
      );
    }

    // ── Freshness (reject future-dated & stale) ──
    const mostRecentEnd = last3[0].monthEnd;
    const daysSinceReport =
      (today.getTime() - mostRecentEnd.getTime()) / MS_PER_DAY;
    if (daysSinceReport < 0) {
      return this._fail(
        result,
        "future_dated_report",
        "تاریخ آخرین گزارش فروش ماهانه در آینده است — داده نامعتبر.",
      );
    }
    if (daysSinceReport > this.policy.monthlyFreshDays + 30) {
      return this._fail(
        result,
        "stale_monthly",
        `آخرین گزارش فروش ماهانه ${mostRecentEnd.toISOString().split("T")[0]} ` +
          `است (${Math.round(daysSinceReport)} روز پیش). داده قدیمی است.`,
      );
    }

    // ── Continuity check ──
    const continuity = this._checkMonthContinuity(last3);
    if (continuity.gapDetected) {
      return this._fail(
        result,
        "monthly_gap",
        `گزارش‌های فروش ماهانه پیوسته نیستند (${continuity.detail}). ` +
          `میانگین سه‌ماهه معتبر نیست.`,
      );
    }
    if (continuity.suspicious) {
      result.reasons.push(`month_spacing_suspicious: ${continuity.detail}`);
    }

    const salesAvgMillions = asMillionsIRR(
      last3.reduce((s, r) => s + r.salesAmountMillionsIRR, 0) / last3.length,
    );
    const annualizedSalesMillions = asMillionsIRR(salesAvgMillions * 12);

    // ── Step 2: net margin ──
    const marginResult = this._determineNetMargin(
      params.quarterly,
      params.flags,
      today,
    );
    if (!marginResult) {
      return this._fail(
        result,
        "no_margin",
        "حاشیه سود قابل اتکا در دسترس نیست. P/E Forward: غیرقابل محاسبه.",
      );
    }
    result.reasons.push(`margin_source: ${marginResult.source}`);

    // ── Step 3: shares (with reconciliation) ──
    const sharesResult = this._resolveShares(
      params.priceData,
      params.quarterly,
    );
    if (!sharesResult) {
      return this._fail(
        result,
        "missing_shares",
        "تعداد سهام ثبت‌شده در دسترس نیست. P/E Forward: غیرقابل محاسبه.",
      );
    }
    if (sharesResult.reconciled) {
      result.reasons.push(`shares_reconciled: ${sharesResult.detail}`);
    }
    const shares = sharesResult.shares;

    // ── Step 4: EPS (unit-safe) ──
    // millionsIRR × 1e6 → IRR; divide by shares → IRR/share
    const annualizedSalesIRR = asIRR(annualizedSalesMillions * 1e6);
    const estimatedEpsIRR = (annualizedSalesIRR * marginResult.margin) / shares;

    if (!Number.isFinite(estimatedEpsIRR) || estimatedEpsIRR <= 0) {
      return this._fail(
        result,
        "non_positive_eps",
        "EPS تخمینی منفی یا صفر است. P/E Forward: غیرقابل محاسبه.",
      );
    }

    result.estimatedAnnualEpsIRR = round(estimatedEpsIRR, 4);

    // ── Step 5: Forward P/E ──
    const forwardPe = price / estimatedEpsIRR;
    result.forwardPe = round(forwardPe, 2);

    // ── Step 6: confidence ──
    const conf = this._scoreConfidence(
      params.quarterly,
      last3,
      marginResult.source,
      params.flags,
      today,
    );
    result.confidence = conf.confidence;
    result.confidenceScore = round(conf.score, 4);
    result.method = conf.method;

    // ── Sources & details ──
    result.sources = {
      salesReportsUsed: last3.length,
      salesLastFetchedISO: new Date(
        Math.max(...last3.map((r) => r.fetchedAt.getTime())),
      ).toISOString(),
      quarterlyFiscalYear: params.quarterly?.fiscalYear ?? null,
      quarterlyPeriodEnd: params.quarterly?.periodEnd.toISOString() ?? null,
      quarterlySourceUrl: params.quarterly?.sourceUrl ?? null,
      netMarginSource: marginResult.source,
      marginUsed: round(marginResult.margin, 6),
      sharesOutstanding: shares,
      sharesSource: sharesResult.source,
      salesAmountsMillions: last3.map((r) => r.salesAmountMillionsIRR),
    };
    result.calculationDetails = {
      trailing3mSalesAvgMillions: round(salesAvgMillions, 2),
      annualizedSalesMillions: round(annualizedSalesMillions, 2),
      annualizedSalesIRR: annualizedSalesMillions * 1e6,
      netMargin: round(marginResult.margin, 6),
      sharesOutstanding: shares,
      estimatedEpsIRR: round(estimatedEpsIRR, 4),
      currentPriceIRR: price,
      forwardPe: round(forwardPe, 2),
    };

    // ── Attractiveness (self-contained) ──
    result.attractivenessScore = computeAttractivenessScore({
      forwardPe: result.forwardPe,
      confidenceScore: result.confidenceScore,
      dailyVolumeShares: params.priceData.dailyVolumeShares ?? undefined,
      marketCapIRR: params.priceData.marketCapIRR ?? undefined,
      priceVolatility30d: params.priceData.priceVolatility30d ?? undefined,
      midCapLogBand: this.policy.midCapLogBand,
    });

    result.disclaimer = this._buildDisclaimer(
      result.confidence,
      marginResult.source,
      params.quarterly,
      last3,
      today,
    );
    return result;
  }

  // ── Helpers ───────────────────────────────────────────

  private _fail(
    result: ForwardPEResult,
    reason: string,
    msg: string,
  ): ForwardPEResult {
    result.reasons.push(reason);
    result.disclaimer = `${msg} P/E Forward: غیرقابل محاسبه.`;
    result.confidence = "non_calculable";
    result.confidenceScore = 0;
    result.method = "non_calculable";
    return result;
  }

  private _checkMonthContinuity(reports: MonthlySalesReport[]): {
    gapDetected: boolean;
    suspicious: boolean;
    detail: string;
  } {
    // Reports are sorted newest → oldest.
    for (let i = 0; i < reports.length - 1; i++) {
      const newer = reports[i].monthEnd.getTime();
      const older = reports[i + 1].monthEnd.getTime();
      const gapDays = (newer - older) / MS_PER_DAY;
      const expected = AVG_MONTH_DAYS;
      const deviation = Math.abs(gapDays - expected);
      if (deviation > this.policy.monthGapToleranceDays) {
        return {
          gapDetected: true,
          suspicious: false,
          detail:
            `فاصله بین ${reports[i + 1].monthEnd.toISOString().split("T")[0]} ` +
            `و ${reports[i].monthEnd.toISOString().split("T")[0]} ` +
            `${gapDays.toFixed(1)} روز است (انتظار ~${expected} روز).`,
        };
      }
      if (deviation > this.policy.monthGapToleranceDays / 2) {
        return {
          gapDetected: false,
          suspicious: true,
          detail: `فاصله ${gapDays.toFixed(1)} روز بین ماه‌ها.`,
        };
      }
    }
    return { gapDetected: false, suspicious: false, detail: "" };
  }

  private _resolveShares(
    price: StockPriceData,
    quarterly: QuarterlyFinancials | null,
  ): {
    shares: Shares;
    source: string;
    reconciled: boolean;
    detail: string;
  } | null {
    const p = price.sharesOutstanding;
    const q = quarterly?.sharesOutstanding ?? null;

    if (p && q) {
      const ratio = Math.abs(p - q) / q;
      if (ratio > this.policy.sharesMismatchRatio) {
        return {
          shares: asShares(p),
          source: "price_data",
          reconciled: true,
          detail:
            `اختلاف ${(ratio * 100).toFixed(1)}٪ بین سهام قیمتی (${p}) ` +
            `و فصلی (${q}) — احتمالاً افزایش سرمایه.`,
        };
      }
      return {
        shares: asShares(p),
        source: "price_data",
        reconciled: false,
        detail: "",
      };
    }
    if (p)
      return {
        shares: asShares(p),
        source: "price_data",
        reconciled: false,
        detail: "",
      };
    if (q)
      return {
        shares: asShares(q),
        source: "quarterly",
        reconciled: false,
        detail: "",
      };
    return null;
  }

  private _determineNetMargin(
    quarterly: QuarterlyFinancials | null,
    flags: InstrumentFlags,
    today: Date,
  ): { margin: number; source: string } | null {
    const {
      isBank,
      isInsurance,
      isHoldingCompany,
      industryAvgMargin,
      sectorAvgMargin,
    } = flags;
    const band = this.policy.marginSanityBand;

    // 1. Quarterly (fresh + has revenue + sane margin)
    if (
      quarterly &&
      quarterly.revenueMillionsIRR &&
      quarterly.revenueMillionsIRR > 0
    ) {
      const age =
        (today.getTime() - quarterly.periodEnd.getTime()) / MS_PER_DAY;
      if (age >= 0 && age <= this.policy.quarterlyFreshDays.low) {
        const adjProfit = this._adjustedNetProfit(quarterly);
        const rawMargin = adjProfit / quarterly.revenueMillionsIRR;
        if (rawMargin >= band.min && rawMargin <= band.max) {
          const cls = isBank
            ? "bank"
            : isInsurance
              ? "insurance"
              : isHoldingCompany
                ? "holding"
                : "general";
          return { margin: rawMargin, source: `quarterly_${cls}_adj` };
        }
        // sanity failure → fall through, but note the reason implicitly via source
      }
    }

    if (industryAvgMargin && industryAvgMargin > 0) {
      return { margin: industryAvgMargin, source: "industry_avg" };
    }
    if (sectorAvgMargin && sectorAvgMargin > 0) {
      return { margin: sectorAvgMargin, source: "sector_avg" };
    }

    if (isBank)
      return { margin: this.policy.defaultMargin.bank, source: "default_bank" };
    if (isInsurance)
      return {
        margin: this.policy.defaultMargin.insurance,
        source: "default_insurance",
      };
    if (isHoldingCompany)
      return {
        margin: this.policy.defaultMargin.holding,
        source: "default_holding",
      };
    return {
      margin: this.policy.defaultMargin.general,
      source: "default_general",
    };
  }

  private _adjustedNetProfit(q: QuarterlyFinancials): number {
    let p = q.netProfitMillionsIRR ?? 0;
    // Extraordinary items are positive magnitudes (schema-enforced).
    if (q.extraordinaryIncomeMillionsIRR) p -= q.extraordinaryIncomeMillionsIRR;
    if (q.extraordinaryExpenseMillionsIRR)
      p += q.extraordinaryExpenseMillionsIRR;
    return p;
  }

  private _scoreConfidence(
    quarterly: QuarterlyFinancials | null,
    monthlyReports: MonthlySalesReport[],
    marginSource: string,
    flags: InstrumentFlags,
    today: Date,
  ): { confidence: Confidence; score: number; method: string } {
    let score = 0;
    const f = this.policy.quarterlyFreshDays;

    if (monthlyReports.length >= 3) score += 0.35;
    else if (monthlyReports.length >= 2) score += 0.25;
    else score += 0.15;

    if (quarterly) {
      const age =
        (today.getTime() - quarterly.periodEnd.getTime()) / MS_PER_DAY;
      if (age >= 0) {
        if (age <= f.high) score += 0.35;
        else if (age <= f.medium) score += 0.25;
        else if (age <= f.low) score += 0.15;
      }
    }

    if (marginSource.startsWith("quarterly")) score += 0.25;
    else if (marginSource.startsWith("industry")) score += 0.2;
    else if (marginSource.startsWith("sector")) score += 0.15;
    else if (marginSource.startsWith("default")) score += 0.1;

    score = Math.min(score, 1.0);

    let method = "monthly_sales_net_margin";
    if (flags.isBank) {
      score *= 0.85;
      method = "monthly_sales_net_margin_bank";
    } else if (flags.isInsurance) {
      score *= 0.8;
      method = "monthly_sales_net_margin_insurance";
    } else if (flags.isHoldingCompany) {
      // Holdcos: data opacity means even perfect inputs cap at "medium".
      // We apply 0.75× AND document it.
      score *= 0.75;
      method = "monthly_sales_net_margin_holding";
    }

    let confidence: Confidence;
    if (score >= 0.75) confidence = "high";
    else if (score >= 0.4) confidence = "medium";
    else confidence = "low";

    return { confidence, score, method };
  }

  private _buildDisclaimer(
    confidence: Confidence,
    marginSource: string,
    quarterly: QuarterlyFinancials | null,
    monthlyReports: MonthlySalesReport[],
    today: Date,
  ): string {
    const parts: string[] = [];
    const n = monthlyReports.length;
    const reportText =
      n === 1 ? "1 گزارش فروش ماهانه" : `${n} گزارش فروش ماهانه`;

    if (confidence === "high") {
      parts.push(
        `اعتمادسنجی: بالا — برآورد بر اساس ${reportText} و صورت‌های مالی فصلی اخیر.`,
      );
    } else if (confidence === "medium") {
      parts.push(
        `اعتمادسنجی: متوسط — برآورد بر اساس ${reportText}، اما حاشیه سود از منبع فرعی به‌دست آمده.`,
      );
    } else {
      parts.push(
        `اعتمادسنجی: پایین — برآورد با ${reportText} محدود یا منطقه‌ای. نتیجه قابل اعتماد نیست.`,
      );
    }

    if (marginSource.startsWith("default")) {
      parts.push(
        "حاشیه سود از پیش‌فرض صنعتی استفاده شده، نه از صورت مالی شرکت.",
      );
    } else if (marginSource.startsWith("industry")) {
      parts.push("حاشیه سود از میانگین صنعتی استخراج شده است.");
    } else if (marginSource.startsWith("sector")) {
      parts.push("حاشیه سود از میانگین بخشی استخراج شده است.");
    }

    if (quarterly) {
      const age =
        (today.getTime() - quarterly.periodEnd.getTime()) / MS_PER_DAY;
      if (age > this.policy.quarterlyFreshDays.medium) {
        parts.push(
          `آخرین صورت مالی فصلی ${quarterly.periodEnd.toISOString().split("T")[0]} است — قدیمی است.`,
        );
      }
    }

    if (monthlyReports.some((r) => r.isEstimated)) {
      parts.push("برخی گزارش‌های فروش ماهانه برآوردی (غیردقیق) هستند.");
    }

    parts.push(
      "⚠️ این P/E Forward یک برآورد است، نه یک پیش‌بینی قیمت. برای تصمیم‌گیری سرمایه‌گذاری از مشاوره حرفه‌ای استفاده کنید.",
    );
    return parts.join(" ");
  }
}

// ──────────────── Attractiveness ─────────────────────────

export function computeAttractivenessScore(params: {
  forwardPe: number | null;
  confidenceScore: number;
  dailyVolumeShares?: number;
  marketCapIRR?: number;
  priceVolatility30d?: number; // fraction
  midCapLogBand?: { low: number; high: number };
}): number | null {
  if (!params.forwardPe || params.forwardPe <= 0) return null;

  // P/E 5 → 0.94, P/E 15 → 0.50, P/E 50 → 0.23
  const inversePeScore = 1.0 / (1.0 + params.forwardPe / 15.0);

  // Liquidity: volume in *shares*. 1e5 → 0.5, 1e9 → 0.9, 1e10 → 1.0 (clamped)
  let liquidityScore = 0;
  if (params.dailyVolumeShares && params.dailyVolumeShares > 0) {
    liquidityScore = clamp(Math.log10(params.dailyVolumeShares) / 10.0, 0, 1);
  }

  // Market cap in *IRR*. Mid-cap band is configurable.
  const band = params.midCapLogBand ?? { low: 13.5, high: 14.5 };
  let mcScore = 0.3;
  if (params.marketCapIRR && params.marketCapIRR > 0) {
    const logMc = Math.log10(params.marketCapIRR);
    mcScore = clamp(logMc / 15.0, 0, 1) * 0.7;
    if (logMc >= band.low && logMc <= band.high) mcScore = 0.85;
  }

  // Volatility as fraction; 0.03 (3%) → 0.91; 0.33+ → 0.
  let stabilityScore = 0.5;
  if (params.priceVolatility30d != null && params.priceVolatility30d > 0) {
    stabilityScore = clamp(1.0 - params.priceVolatility30d * 3.0, 0, 1);
  }

  const score =
    (inversePeScore * 0.3 +
      clamp(params.confidenceScore, 0, 1) * 0.25 +
      liquidityScore * 0.25 +
      mcScore * 0.1 +
      stabilityScore * 0.1) *
    100;

  return round(score, 2);
}

// ──────────────── Small utilities ────────────────────────

const round = (n: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(n, lo), hi);
