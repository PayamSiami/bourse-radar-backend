#!/usr/bin/env tsx
/**
 * Create admin user script
 * Usage: node --experimental-strip-types scripts/create-admin.ts
 */

import "dotenv/config";
import postgres from "postgres";
import bcrypt from "bcryptjs";

async function main() {
  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connect_timeout: 10,
  });

  try {
    console.log("Creating admin user...");

    // Check if admin already exists
    const existingAdmin = await sql<{ id: number }[]>`
      SELECT id FROM users WHERE is_admin = true LIMIT 1
    `;

    if (existingAdmin.length > 0) {
      console.log(`Admin user already exists (ID: ${existingAdmin[0].id})`);
      return;
    }

    // Get admin credentials from env
    const adminEmail = process.env.ADMIN_EMAIL || "admin@bourse-radar.ir";
    const adminPassword = process.env.ADMIN_PASSWORD || "Admin123!@#";

    // Hash password
    const passwordHash = await bcrypt.hash(adminPassword, 12);

    // Insert admin user
    const result = await sql`
      INSERT INTO users (email, password_hash, username, display_name, is_admin, created_at, updated_at)
      VALUES (${adminEmail}, ${passwordHash}, 'admin', 'مدیر سیستم', true, NOW(), NOW())
      RETURNING id, email, username, display_name, is_admin, created_at, updated_at
    `;

    if (result.length === 0) {
      throw new Error("Failed to create admin user");
    }

    const admin = result[0];
    console.log(`✅ Admin user created successfully!`);
    console.log(`   Email: ${admin.email}`);
    console.log(`   Name: ${admin.display_name}`);
    console.log(`   ID: ${admin.id}`);
    console.log(`\n   Default password: ${adminPassword}`);
    console.log(`   ⚠️ Please change the password after first login!`);
    console.log(`\n   To test: curl -v -X POST "http://localhost:8001/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"${adminEmail}\",\"password\":\"${adminPassword}\"}"`);

  } catch (e: any) {
    console.error("❌ Failed to create admin user:", e.message);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 3 });
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
