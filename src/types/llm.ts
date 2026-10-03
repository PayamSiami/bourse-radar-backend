/**
 * Types for the LLM narrative-generation layer.
 * The LLM never produces buy/sell signals — it only explains
 * WHY a stock appears attractive or risky based on quantitative metrics.
 */

/** The single stock input that the LLM receives for narrative generation */
export interface LlmStockInput {
  symbol: string;
  name: string;
  sector: string | null;
  currentPrice: number | null;
  trailingPe: number | null;
  forwardPe: number | null;
  forwardPeConfidence: "high" | "medium" | "low" | "non_calculable";
  confidenceScore: number;
  estimatedAnnualEps: number | null;
  netMargin: number | null;
  marketCap: number | null;
  dailyVolume: bigint | null;
  volumeValue: number | null;
  priceChange24h: number | null;
  priceChangePercent24h: number | null;
  rankingPosition: number;          // 1-based position in overall ranking
  totalStocksRanked: number;
  liquidityPercentile: number;      // 0–100 percentile within sector
  marketCapPercentile: number;      // 0–100 within sector
  dataFreshness: {
    priceAgeSeconds: number | null;
    salesAgeDays: number | null;
    quarterlyAgeDays: number | null;
  };
  isBank: boolean;
  isInsurance: boolean;
  isHoldingCompany: boolean;
  calculationDisclaimer: string;
}

/** Structured output from the LLM — validated with Zod */
export interface LlmNarrativeOutput {
  /** Short headline ≤ 140 chars */
  headline: string;
  /** 2–3 paragraph analysis in Persian (markdown) */
  analysis: string;
  /** Why this stock ranks where it does */
  quantitativeReasoning: string;
  /** Explicit caveats about data quality and estimation uncertainty */
  uncertaintyDisclosure: string;
  /** Array of risk factors (each ≤ 1 sentence) */
  riskFactors: string[];
  /** Array of positive factors (each ≤ 1 sentence) */
  positiveFactors: string[];
  /** Explicit statement that this is not investment advice */
  disclaimer: string;
  /** Token usage metadata */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Ranking summary that the LLM may reference */
export interface LlmRankingContext {
  totalStocks: number;
  sectorName: string | null;
  sectorRank: number;
  overallRank: number;
  top3InSector: string[];
}
