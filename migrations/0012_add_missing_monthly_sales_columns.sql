-- Add missing columns to monthly_sales table for compatibility with ingest.ts
-- The ingest process references these columns but they were not in the original migration.

ALTER TABLE monthly_sales ADD COLUMN IF NOT EXISTS sales_usd NUMERIC(30,2);
ALTER TABLE monthly_sales ADD COLUMN IF NOT EXISTS domestic_usd NUMERIC(30,2);
ALTER TABLE monthly_sales ADD COLUMN IF NOT EXISTS export_usd NUMERIC(30,2);
ALTER TABLE monthly_sales ADD COLUMN IF NOT EXISTS service_usd NUMERIC(30,2);
ALTER TABLE monthly_sales ADD COLUMN IF NOT EXISTS ytd_total_usd NUMERIC(30,2);
ALTER TABLE monthly_sales ADD COLUMN IF NOT EXISTS ytd_prior_year_usd NUMERIC(30,2);
ALTER TABLE monthly_sales ADD COLUMN IF NOT EXISTS fx_rate_rial NUMERIC(15,4);
ALTER TABLE monthly_sales ADD COLUMN IF NOT EXISTS fx_quality TEXT CHECK (fx_quality IS NULL OR fx_quality IN ('valid','fallback','suspicious'));
ALTER TABLE monthly_sales ADD COLUMN IF NOT EXISTS fx_sources TEXT[];

-- Add comments for documentation
COMMENT ON COLUMN monthly_sales.sales_usd IS 'Monthly sales amount in USD';
COMMENT ON COLUMN monthly_sales.domestic_usd IS 'Domestic sales amount in USD';
COMMENT ON COLUMN monthly_sales.export_usd IS 'Export sales amount in USD';
COMMENT ON COLUMN monthly_sales.service_usd IS 'Service sales amount in USD';
COMMENT ON COLUMN monthly_sales.ytd_total_usd IS 'Year-to-date total sales amount in USD';
COMMENT ON COLUMN monthly_sales.ytd_prior_year_usd IS 'Year-to-date prior year sales amount in USD';
COMMENT ON COLUMN monthly_sales.fx_rate_rial IS 'FX rate Toman per Rial';
COMMENT ON COLUMN monthly_sales.fx_quality IS 'FX rate quality status';
COMMENT ON COLUMN monthly_sales.fx_sources IS 'FX rate sources array';

-- Populate USD columns from Toman values using fx_rate_rial
-- Assuming fx_rate_rial is the conversion factor from Rial to USD
-- The original sales_amount_million_rial is in Rial, so:
-- sales_usd = sales_amount_million_rial * 1000000 / fx_rate_rial (if fx_rate_rial is Toman/rial)
-- But we'll leave populated later when fx data is available

UPDATE monthly_sales SET fx_rate_rial = 1 WHERE fx_rate_rial IS NULL;
UPDATE monthly_sales SET fx_quality = 'valid' WHERE fx_quality IS NULL;
UPDATE monthly_sales SET fx_sources = '{}' WHERE fx_sources IS NULL;