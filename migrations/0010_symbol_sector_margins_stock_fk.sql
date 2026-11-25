-- Link symbol_sector_margins.symbol to stocks.symbol so AdminJS
-- renders a stock picker (dropdown of symbol + name) instead of free text.
--
-- stocks.symbol is TEXT, so the FK column must be TEXT too.
-- Existing VARCHAR values cast cleanly. Orphan symbols are removed first
-- because a foreign key cannot be added while they exist.

ALTER TABLE symbol_sector_margins
    ALTER COLUMN symbol TYPE TEXT;

DELETE FROM symbol_sector_margins m
WHERE NOT EXISTS (
    SELECT 1 FROM stocks s WHERE s.symbol = m.symbol
);

ALTER TABLE symbol_sector_margins
    DROP CONSTRAINT IF EXISTS symbol_sector_margins_symbol_fkey;

ALTER TABLE symbol_sector_margins
    ADD CONSTRAINT symbol_sector_margins_symbol_fkey
    FOREIGN KEY (symbol) REFERENCES stocks (symbol)
    ON UPDATE CASCADE
    ON DELETE RESTRICT;
