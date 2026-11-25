-- Add missing columns to quarterly_financials table for compatibility with ingest.ts
-- The ingest process references these columns but they were not in the original migration.

ALTER TABLE quarterly_financials ADD COLUMN IF NOT EXISTS revenue NUMERIC(30,2);
ALTER TABLE quarterly_financials ADD COLUMN IF NOT EXISTS net_profit NUMERIC(30,2);
ALTER TABLE quarterly_financials ADD COLUMN IF NOT EXISTS net_margin NUMERIC(8,6) CHECK (net_margin IS NULL OR net_margin BETWEEN -1 AND 1);

-- Add comments for documentation
COMMENT ON COLUMN quarterly_financials.revenue IS 'Quarterly revenue in Rial (derived from revenue_billion_rial)';
COMMENT ON COLUMN quarterly_financials.net_profit IS 'Quarterly net profit in Rial (derived from net_profit_billion_rial)';
COMMENT ON COLUMN quarterly_financials.net_margin IS 'Net margin as decimal (net_profit / revenue)';

-- Populate from existing columns (convert billions to actual rial)
UPDATE quarterly_financials SET revenue = revenue_billion_rial * 1000000000 WHERE revenue IS NULL AND revenue_billion_rial IS NOT NULL;
UPDATE quarterly_financials SET net_profit = net_profit_billion_rial * 1000000000 WHERE net_profit IS NULL AND net_profit_billion_rial IS NOT NULL;
UPDATE quarterly_financials SET net_margin = net_profit_billion_rial / NULLIF(revenue_billion_rial, 0) WHERE net_margin IS NULL AND revenue_billion_rial IS NOT NULL AND revenue_billion_rial > 0;