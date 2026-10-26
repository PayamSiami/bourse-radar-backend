#!/usr/bin/env tsx
/**
 * Admin API Client
 * Usage examples for admin operations
 */

const API_BASE = process.env.API_URL || "http://localhost:8001";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@bourse-radar.ir";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin123!@#";

async function login() {
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });

  if (!response.ok) {
    throw new Error("Login failed");
  }

  const data = await response.json();
  return data.token;
}

function getAuthHeaders(token: string) {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// User Management
export async function listUsers(token: string, page = 1, search = "") {
  const response = await fetch(
    `${API_BASE}/api/admin/users?page=${page}&search=${encodeURIComponent(search)}`,
    { headers: getAuthHeaders(token) }
  );
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list users: ${error}`);
  }

  const data = await response.json();
  console.log("Users:", data.data);
  return data.data;
}

export async function getUser(token: string, userId: number) {
  const response = await fetch(`${API_BASE}/api/admin/users/${userId}`, {
    headers: getAuthHeaders(token),
  });

  if (!response.ok) {
    throw new Error("Failed to get user");
  }

  const data = await response.json();
  console.log("User:", data.data);
  return data.data;
}

export async function updateUserRole(token: string, userId: number, isAdmin: boolean) {
  const response = await fetch(`${API_BASE}/api/admin/users/${userId}/role`, {
    method: "PUT",
    headers: getAuthHeaders(token),
    body: JSON.stringify({ is_admin: isAdmin }),
  });

  if (!response.ok) {
    throw new Error("Failed to update user role");
  }

  const data = await response.json();
  console.log("User role updated:", data.data);
  return data.data;
}

export async function deleteUser(token: string, userId: number) {
  const response = await fetch(`${API_BASE}/api/admin/users/${userId}`, {
    method: "DELETE",
    headers: getAuthHeaders(token),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to delete user: ${error}`);
  }

  const data = await response.json();
  console.log("User deleted:", data.message);
}

// Ticket Management
export async function listTickets(token: string, page = 1, status = "") {
  let url = `${API_BASE}/api/admin/tickets?page=${page}`;
  if (status) {
    url += `&status=${encodeURIComponent(status)}`;
  }

  const response = await fetch(url, {
    headers: getAuthHeaders(token),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list tickets: ${error}`);
  }

  const data = await response.json();
  console.log("Tickets:", data.data);
  return data.data;
}

export async function getTicket(token: string, ticketId: number) {
  const response = await fetch(`${API_BASE}/api/admin/tickets/${ticketId}`, {
    headers: getAuthHeaders(token),
  });

  if (!response.ok) {
    throw new Error("Failed to get ticket");
  }

  const data = await response.json();
  console.log("Ticket:", data.data);
  return data.data;
}

export async function updateTicketStatus(token: string, ticketId: number, status: string) {
  const response = await fetch(`${API_BASE}/api/admin/tickets/${ticketId}/status`, {
    method: "PUT",
    headers: getAuthHeaders(token),
    body: JSON.stringify({ status }),
  });

  if (!response.ok) {
    throw new Error("Failed to update ticket status");
  }

  const data = await response.json();
  console.log("Ticket status updated:", data.data);
  return data.data;
}

export async function addTicketMessage(token: string, ticketId: number, message: string) {
  const response = await fetch(`${API_BASE}/api/admin/tickets/${ticketId}/message`, {
    method: "POST",
    headers: getAuthHeaders(token),
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    throw new Error("Failed to add message");
  }

  const data = await response.json();
  console.log("Message added:", data.data);
  return data.data;
}

// Stock Management
export async function updateStock(token: string, symbol: string, updates: any) {
  const response = await fetch(`${API_BASE}/api/admin/stocks/${symbol}`, {
    method: "PUT",
    headers: getAuthHeaders(token),
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    throw new Error("Failed to update stock");
  }

  const data = await response.json();
  console.log("Stock updated:", data.data);
  return data.data;
}

export async function deleteStock(token: string, symbol: string) {
  const response = await fetch(`${API_BASE}/api/admin/stocks/${symbol}`, {
    method: "DELETE",
    headers: getAuthHeaders(token),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to delete stock: ${error}`);
  }

  const data = await response.json();
  console.log("Stock deleted:", data.message);
}

// Admin Dashboard
export async function getAdminStats(token: string) {
  const response = await fetch(`${API_BASE}/api/admin/dashboard/stats`, {
    headers: getAuthHeaders(token),
  });

  if (!response.ok) {
    throw new Error("Failed to get dashboard stats");
  }

  const data = await response.json();
  console.log("Admin Stats:", data.data);
  return data.data;
}

// Main example usage
async function main() {
  try {
    console.log("Logging in as admin...");
    const token = await login();
    console.log("✅ Logged in successfully");

    console.log("\n=== Getting admin stats ===");
    await getAdminStats(token);

    console.log("\n=== Listing users ===");
    await listUsers(token, 1, "");

    console.log("\n=== Listing tickets ===");
    await listTickets(token, 1, "open");

    console.log("\nExit");
  } catch (error: any) {
    console.error("Error:", error.message);
  }
}

// Export for use as module
export { login, getAuthHeaders };
if (require.main === module) {
  main().catch(console.error);
}
