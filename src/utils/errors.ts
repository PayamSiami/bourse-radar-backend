/**
 * Custom error classes for Bourse Radar.
 * All errors extend FastifyError for consistent HTTP error responses.
 */

import createError from "@fastify/error";

export const StockNotFoundError = createError(
  "FST_ERR_STOCK_NOT_FOUND",
  "Symbol {symbol} not found — verify the ticker is a valid TSE instrument.",
  404,
);

export const DataUnavailableError = createError(
  "FST_ERR_DATA_UNAVAILABLE",
  "No data sources are currently available for symbol {symbol}. Check back shortly or use stale cache.",
  503,
);

export const ForwardPEUnavailableError = createError(
  "FST_ERR_FORWARD_PE_UNAVAILABLE",
  "Forward P/E is non_calculable for {symbol}: missing monthly sales or quarterly financials.",
  422,
);

export const LlmUnavailableError = createError(
  "FST_ERR_LLM_UNAVAILABLE",
  "LLM narrative generation is unavailable. Raw rankings are provided instead.",
  503,
);

export interface StaleDataWarning {
  symbol: string;
  field: string;
  ageSeconds: number;
  isStale: true;
}
