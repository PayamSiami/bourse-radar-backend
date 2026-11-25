-- Add sales_amount column to monthly_sales table for compatibility
-- The existing column sales_amount_million_rial keeps the original meaning
-- (sales in millions of Rial). This new column sales_amount provides direct access
-- to the numeric value used throughout the codebase.

ALTER TABLE monthly_sales ADD COLUMN IF NOT EXISTS sales_amount NUMERIC(30,2);

-- Populate sales_amount from sales_amount_million_rial for existing rows
-- (multiply by 1 million to get actual rial amount, or keep as-is if already in rial)
-- Based on the comment: "sales_amount_million_rial is the canonical monthly sales figure (Rial, in millions)"
-- So sales_amount_million_rial = value in millions of Rial
-- If we want sales_amount to be in actual Rial, multiply by 1000000
-- But looking at code usage, it seems sales_amount might already be in rial in some places
-- Let's set sales_amount = sales_amount_million_rial * 1000000 (convert millions to actual rial)

UPDATE monthly_sales SET sales_amount = sales_amount_million_rial * 1000000 WHERE sales_amount IS NULL;

-- Add comment for documentation
COMMENT ON COLUMN monthly_sales.sales_amount IS 'Monthly sales figure in Rial (derived from sales_amount_million_rial)';