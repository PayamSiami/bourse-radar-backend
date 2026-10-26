import "dotenv/config";
import postgres from "postgres";
import bcrypt from "bcryptjs";

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    // Check if admin user exists by admin flag
    const existingAdmin =
      await sql`SELECT id, email, username FROM users WHERE is_admin = true LIMIT 1`;

    if (existingAdmin.length === 0) {
      console.log(`Creating new admin user: ${adminEmail}`);
      const passwordHash = await bcrypt.hash(adminPassword, 12);

      await sql`
        INSERT INTO users (email, password_hash, username, display_name, is_admin, created_at, updated_at)
        VALUES (${adminEmail}, ${passwordHash}, 'admin', 'مدیر سیستم', true, NOW(), NOW())
      `;
      console.log(`✅ Admin user created: ${adminEmail}`);
    } else {
      const adminId = existingAdmin[0].id;
      const currentEmail = existingAdmin[0].email;
      console.log(
        `Admin user exists with ID: ${adminId}, email: ${currentEmail}`,
      );

      // Update credentials to ensure correct values
      console.log("Updating admin user credentials...");
      const passwordHash = await bcrypt.hash(adminPassword, 12);

      await sql`
        UPDATE users
        SET email = ${adminEmail}, password_hash = ${passwordHash}, updated_at = NOW()
        WHERE id = ${adminId}
      `;
      console.log(`✅ Admin user ${adminEmail} updated with fresh credentials`);
    }

    console.log(`\n📋 Test login:`);
    console.log(`Email: ${adminEmail}`);
    console.log(`Password: ${adminPassword}`);
    console.log(
      `\nTry: curl -v -X POST "http://localhost:8001/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"${adminEmail}\",\"password\":\"${adminPassword}\"}"`,
    );
  } catch (error) {
    console.error("❌ Failed:", error.message);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 3 });
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
