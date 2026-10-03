-- 0005_stocks_ins_code.sql
-- Add TSETMC insCode to stocks (needed for order book API)

ALTER TABLE stocks
  ADD COLUMN IF NOT EXISTS ins_code TEXT;

-- Unique index (partial — allows multiple NULLs)
CREATE UNIQUE INDEX IF NOT EXISTS idx_stocks_ins_code_unique
  ON stocks (ins_code)
  WHERE ins_code IS NOT NULL;

-- Also add detail JSONB to monthly_sales if missing
ALTER TABLE monthly_sales
  ADD COLUMN IF NOT EXISTS detail JSONB;

-- Indexes for chart queries
CREATE INDEX IF NOT EXISTS idx_quarterly_period
  ON quarterly_financials (symbol, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_monthly_sales_month
  ON monthly_sales (month_end DESC);