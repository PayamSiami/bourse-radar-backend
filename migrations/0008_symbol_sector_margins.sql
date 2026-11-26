-- 0008_symbol_sector_margins.sql
-- Creates symbol_sector_margins table with FK to stocks(symbol).
-- Handles both fresh databases and live databases that may have a pre-existing
-- symbol_sector_margins table without the sector column.
--
-- Strategy:
-- 1. If table exists with wrong schema: drop and recreate (data loss accepted for new table)
-- 2. If table doesn't exist: create fresh
-- 3. Add indexes for AdminJS stock picker queries

DO $check_table$
DECLARE
    table_exists boolean;
    has_sector_column boolean;
BEGIN
    -- Check if table already exists
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'symbol_sector_margins'
    ) INTO table_exists;

    IF table_exists THEN
        -- Table exists; check if it has the sector column
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'symbol_sector_margins' AND column_name = 'sector'
        ) INTO has_sector_column;

        IF has_sector_column THEN
            -- Table already has correct schema; no action needed
            RAISE NOTICE 'symbol_sector_margins table already has sector column — skipping';
        ELSE
            -- Table exists but missing sector column: drop and recreate
            RAISE NOTICE 'symbol_sector_margins exists without sector column: recreating';
            EXECUTE 'DROP TABLE symbol_sector_margins';
            -- Fall through to CREATE TABLE below
        END IF;
    END IF;

    -- Create the table (runs whether we just dropped it or it didn't exist)
    CREATE TABLE IF NOT EXISTS symbol_sector_margins (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL REFERENCES stocks(symbol) ON UPDATE CASCADE ON DELETE RESTRICT,
        sector TEXT,
        profit_margin NUMERIC(5,2) NOT NULL DEFAULT 0,
        effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
        effective_to DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Add indexes for common query patterns
    CREATE INDEX IF NOT EXISTS idx_symbol_sector_margins_symbol ON symbol_sector_margins(symbol);
    CREATE INDEX IF NOT EXISTS idx_symbol_sector_margins_sector ON symbol_sector_margins(sector);
    CREATE INDEX IF NOT EXISTS idx_symbol_sector_margins_effective
        ON symbol_sector_margins(effective_from, effective_to);

    -- Add trigger for updated_at if not already present
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_symbol_sector_margins_updated_at'
    ) THEN
        CREATE TRIGGER trg_symbol_sector_margins_updated_at
            BEFORE UPDATE ON symbol_sector_margins
            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;

    RAISE NOTICE 'symbol_sector_margins table created/updated successfully';
END
$check_table$;