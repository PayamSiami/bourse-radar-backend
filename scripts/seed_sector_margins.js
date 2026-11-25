// Seed script for symbol_sector_margins table
// Runs once to populate sample profit margin data for all four quarters
//
// Usage: node scripts/seed_sector_margins.js "<DATABASE_URL>"
//
// This script generates margin data for 4 quarters per symbol
// and inserts into PostgreSQL via node-postgres.

// Watchlist items - copied from ingest.ts WATCHLIST
const WATCHLIST = [
  // ── فلزات اساس (Basic Metals) ──────────────────────
  { sym: "فولاد", name: "فولاد مبارکه", type: "general" },
  { sym: "فزر", name: "پویا زرکان آق دره", type: "general" },
  { sym: "فخوز", name: "فولاد خوزستان", type: "general" },
  { sym: "فخاس", name: "فولاد خراسان", type: "general" },
  { sym: "ذوب", name: "ذوب‌آهن اصفهان", type: "general" },
  { sym: "فملی", name: "ملی صنایع مس ایران", type: "general" },
  { sym: "فایرا", name: "آلومینیوم ایران", type: "general" },
  { sym: "فمراد", name: "آلومراد", type: "general" },
  { sym: "فپارس", name: "آلومینیوم پارس", type: "general" },
  { sym: "فالوم", name: "آلومتک", type: "general" },
  { sym: "فزرین", name: "معدن زرین آسیا", type: "general" },
  { sym: "فجر", name: "فولاد امیرکبیر کاشان", type: "general" },
  { sym: "فاراک", name: "ماشین‌سازی اراک", type: "general" },
  { sym: "فوکا", name: "فولاد کاویان", type: "general" },
  { sym: "فسرب", name: "ملی سرب و روی", type: "general" },
  { sym: "فسوژ", name: "سوژمیران", type: "general" },
  { sym: "فباهنر", name: "صنایع مس شهید باهنر", type: "general" },
  { sym: "فسبزوار", name: "پارس فولاد سبزوار", type: "general" },
  { sym: "فاسمین", name: "کالسیمین", type: "general" },
  { sym: "کروی", name: "توسعه معادن روی ایران", type: "general" },
  { sym: "کگل", name: "گل‌گهر", type: "general" },
  { sym: "کچاد", name: "چادرملو", type: "general" },

  // ── زراعت و دام (Agriculture & Livestock) ──────────
  { sym: "زشگزا", name: "شیر و گوشت زاگرس شهرکرد", type: "general" },

  // ── پالایش و پتروشیمی (Refining & Petrochemical) ────
  { sym: "شپنا", name: "پالایش نفت اصفهان", type: "general" },
  { sym: "شبندر", name: "پالایش نفت بندرعباس", type: "general" },
  { sym: "شتران", name: "پالایش نفت تهران", type: "general" },
  { sym: "شبریز", name: "پالایش نفت تبریز", type: "general" },
  { sym: "شپدیس", name: "پتروشیمی پردیس", type: "general" },
  { sym: "شیراز", name: "پتروشیمی شیراز", type: "general" },
  { sym: "شاراک", name: "پتروشیمی شازند", type: "general" },
  { sym: "شپارس", name: "بین‌المللی محصولات پارس", type: "general" },
  { sym: "شپاکسا", name: "پاکسان", type: "general" },
  { sym: "شخارک", name: "پتروشیمی خارک", type: "general" },
  { sym: "تاپیکو", name: "سرمایه‌گذاری نفت و گاز تامین", type: "general" },

  // ── شیمیایی (Chemicals) ─────────────────────────────
  { sym: "شکام", name: "صنایع شیمیایی کیمیاگران امروز", type: "general" },
  { sym: "شسینا", name: "صنایع شیمیایی سینا", type: "general" },
  { sym: "شبصیر", name: "پتروشیمی قائد بصیر", type: "general" },
  { sym: "شغدیر", name: "پتروشیمی غدیر", type: "general" },

  // ── automotive (Automotive) ─────────────────────────
  { sym: "ايران‌خودرو", name: "伊朗 خودرو", type: "general" },
  { sym: "موتورساز", name: "موتورساز", type: "general" },
  { sym: "کت-made", name: "کت-generated", type: "general" },

  // ── bank (Bank) ─────────────────────────────────────
  { sym: "م Gulf", name: " Gulf", type: "bank" },
  { sym: " Mellat", name: " Mellat", type: "bank" },
  { sym: "Saman", name: " Saman", type: "bank" },
  { sym: "Melli", name: " Melli", type: "bank" },
  { sym: "Tejarat", name: " Tejarat", type: "bank" },

  // ── insurance (Insurance) ───────────────────────────
  { sym: "Asia", name: "Asia", type: "insurance" },
  { sym: "Mahan", name: " Mahan", type: "insurance" },
  { sym: "Afghan", name: " Afghan", type: "insurance" },

  // ── holding (Holding) ───────────────────────────────
  { sym: " Darya", name: " Darya", type: "holding" },
  { sym: "Mapna", name: " Mapna", type: "holding" },
];

// Extract symbols
const WATCHLIST_SYMBOLS = new Set(WATCHLIST.map((w) => w.sym));

// Generate random profit margin
function randomMargin() {
  return Math.round((Math.random() * 24.5 + 0.5) * 100) / 100; // 0.50 to 25.00
}

// Persian (Solar Hijri) quarter definitions
// Converted to Gregorian dates (approx):
// Nowruz ≈ March 21, 1403 SH = March 20, 2024 CE
// Year 1403 SH = March 20, 2024 to March 19, 2025 CE
const quarters = [
  { id: 1, name: "first", from: "2024-03-21", to: "2024-06-21" }, // Farvardin + Ordibehesht + Khordad
  { id: 2, name: "second", from: "2024-06-22", to: "2024-09-22" }, // Tir + Mordad + Shahrivar
  { id: 3, name: "third", from: "2024-09-23", to: "2024-12-21" }, // Mehr + Aban + Azar
  { id: 4, name: "fourth", from: "2024-12-22", to: "2025-03-20" }, // Dey + Bahman + Esfand
];

// Get DATABASE_URL
const dbUrl = process.argv[2] || process.env.DATABASE_URL;

if (!dbUrl) {
  console.error("❌ DATABASE_URL not provided. Usage: node seed_sector_margins.js \"postgres://user:pass@host:port/db\"");
  process.exit(1);
}

import { Pool } from "pg";
const pool = new Pool({ connectionString: dbUrl });

async function main() {
  console.log("🌱 Starting sector margins seed...");

  const client = await pool.connect();

  try {
    // Verify table exists
    const { rows } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'symbol_sector_margins'"
    );

    if (rows.length === 0) {
      console.error("❌ Table symbol_sector_margins does not exist. Run migrations first.");
      process.exit(1);
    }

    // Get existing symbols from stocks table
    const { rows: stocks } = await client.query("SELECT symbol FROM stocks ORDER BY symbol");
    const stockSymbols = stocks.map((s) => s.symbol);

    // Process all stocks from DB (ensures FK constraint satisfied)
    // Also include any WATCHLIST symbols that exist in stocks
    const watchlistInDb = [...WATCHLIST_SYMBOLS].filter((s) => stockSymbols.includes(s));
    const symbolsToProcess = [...new Set([...stockSymbols, ...watchlistInDb])];

    console.log(`📊 Processing ${symbolsToProcess.length} stocks (from DB) across ${quarters.length} quarters = ${symbolsToProcess.length * quarters.length} total records`);

    // Generate all values
    const values = [];
    const seen = new Set();

    for (const sym of symbolsToProcess) {
      for (const q of quarters) {
        const key = `${sym}-${q.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const margin = randomMargin().toFixed(2);
        let sector = "general";

        // Simple sector detection based on symbol patterns
        const lower = sym.toLowerCase();
        if (lower.includes(" petro") || lower.includes(" نفت") || lower.includes(" petrol")) {
          sector = "petrochemical";
        } else if (lower.includes(" bank")) {
          sector = "bank";
        } else if (lower.includes(" sigar") || lower.includes(" 담배")) {
          sector = "tobacco";
        }

        values.push({
          symbol: sym,
          sector,
          profit_margin: margin,
          effective_from: q.from,
          effective_to: q.to,
        });
      }
    }

    // Insert (no conflict handling — seed runs once)
    const insertQuery = `
      INSERT INTO symbol_sector_margins (symbol, sector, profit_margin, effective_from, effective_to)
      VALUES ($1, $2, $3, $4, $5)
    `;

    // Execute in batches
    const BATCH_SIZE = 100;
    let total = 0;

    for (let i = 0; i < values.length; i += BATCH_SIZE) {
      const batch = values.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map((v) =>
        client.query(insertQuery, [v.symbol, v.sector, v.profit_margin, v.effective_from, v.effective_to])
      );
      await Promise.all(batchPromises);
      total += batch.length;
      console.log(`   ${total}/${values.length} rows inserted...`);
    }

    console.log(`✅ Done! Inserted/updated ${total} sector margin records`);
    console.log(`📊 View in AdminJS at: http://localhost:8001/admin → Sector Margins`);
  } finally {
    await client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});