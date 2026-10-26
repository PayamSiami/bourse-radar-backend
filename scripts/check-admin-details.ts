import "dotenv/config";
import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    const user = await sql`
      SELECT id, email, username, display_name, password_hash, is_admin, verified, created_at 
      FROM users 
      WHERE id = 9
    `;
    console.log(JSON.stringify(user, null, 2));
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await sql.end();
  }
}

main().catch(console.error);
