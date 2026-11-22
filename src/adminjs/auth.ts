
import argon2 from "argon2";

export interface AdminUser {
  email: string;
  role: "admin";
}

function adminCredentials() {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminEmail || !adminPasswordHash) {
    return null;
  }

  return { adminEmail, adminPasswordHash };
}

export async function authenticateAdmin(
  email: string,
  password: string,
): Promise<AdminUser | null> {
  const credentials = adminCredentials();

  if (!credentials) {
    return null;
  }

  const { adminEmail, adminPasswordHash } = credentials;

  if (!email || !password) {
    return null;
  }

  if (email.trim().toLowerCase() !== adminEmail) {
    return null;
  }

  try {
    const valid = await argon2.verify(
      adminPasswordHash,
      password,
    );

    if (!valid) {
      return null;
    }

    return {
      email: adminEmail,
      role: "admin",
    };
  } catch {
    return null;
  }
}
