-- 0004_quarterly_eps.sql
-- Add eps_rials to quarterly_financials for earnings charts.
-- eps_rials = (net_profit in million IRR × 1e6) / shares_outstanding

ALTER TABLE quarterly_financials
  ADD COLUMN IF NOT EXISTS eps_rials NUMERIC(20, 4);

-- Backfill from existing data
UPDATE quarterly_financials
SET eps_rials = (net_profit * 1000000) / NULLIF(shares_outstanding, 0)
WHERE eps_rials IS NULL
  AND net_profit IS NOT NULL
  AND shares_outstanding IS NOT NULL
  AND shares_outstanding > 0;

-- Index for chart queries
CREATE INDEX IF NOT EXISTS idx_quarterly_eps
  ON quarterly_financials (symbol, period_end DESC);