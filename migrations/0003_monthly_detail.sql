-- 0003_monthly_detail.sql
-- Bourse Radar — add structured monthly financial report detail.
-- The monthly_sales table gets a JSONB column storing the full report
-- breakdown (domestic/export/services totals, YTD, prior-year, products)
-- extracted via extractMonthlyReport(). Existing sales_amount stays as
-- the canonical monthly sales figure for Backward P/E compatibility.

ALTER TABLE monthly_sales ADD COLUMN IF NOT EXISTS detail JSONB;

COMMENT ON COLUMN monthly_sales.detail IS
  'Structured monthly report: {periodEnd, goods:[], totals:[{rowCode,label,...}], monthlySalesTotal, ytdSalesTotal, priorYtdSalesTotal, domesticMonthly, exportMonthly}';
