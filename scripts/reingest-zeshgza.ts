#!/usr/bin/env tsx
import "dotenv/config";
import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connect_timeout: 10,
  });

  try {
    const result = await sql`
      SELECT * FROM quarterly_financials WHERE symbol = 'شاراک';
    `;
    console.log(JSON.stringify(result));
  } finally {
    await sql.end({ timeout: 3 });
  }
}

main().catch((err) => {
  console.error(err);
});
//  npx tsx scripts/reingest-zeshgza.ts 

// DELETE FROM quarterly_financials;
// DELETE FROM forward_pe;
// DELETE FROM stocks;
// DELETE FROM market_cap_history;

// SELECT symbol, period_end, revenue, net_profit, (net_profit/revenue)*100 as margin_pct
// FROM quarterly_financials
// WHERE symbol = 'زشگزا'
// ORDER BY period_end DESC;

// SELECT symbol, period_end, net_margin, quarter, created_at
// FROM quarterly_financials
// WHERE symbol = 'زشگزا'
// ORDER BY period_end DESC
// LIMIT 5;

// SELECT symbol, period_end, net_margin, quarter, revenue, net_profit
// FROM quarterly_financials
// WHERE symbol = 'زشگزا'
// ORDER BY period_end DESC;

// SELECT * FROM quarterly_financials WHERE symbol = 'شاراک' ORDER BY period_end DESC LIMIT 5;