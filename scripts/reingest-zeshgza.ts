#!/usr/bin/env tsx
import "dotenv/config";
import postgres from "postgres";

async function main() {
const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  connect_timeout: 10,
});


  try {
    console.log("1. Deleting old monthly_sales for زشگزا...");
    const deleted = await sql`
      DELETE FROM monthly_sales 
      WHERE symbol = 'زشگزا'
      RETURNING month_end
    `;
    console.log(`   Deleted ${deleted.length} rows`);
  } finally {
    await sql.end({ timeout: 3 });
  }
}

main().catch((err) => {
  console.error(err);
});