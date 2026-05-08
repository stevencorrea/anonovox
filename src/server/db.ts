import { SQL } from "bun";
import type { PoolConfig } from "pg";

const DATABASE_URL = process.env.DATABASE_URL?.trim();

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

export function getDatabasePoolConfig(): PoolConfig {
  return { connectionString: DATABASE_URL };
}

export const sql = new SQL(DATABASE_URL);

export function describeDatabaseConfig(): Record<string, string | number | boolean> {
  try {
    const parsed = new URL(DATABASE_URL);
    return {
      mode: "database-url",
      protocol: parsed.protocol.replace(":", ""),
      host: parsed.hostname,
      port: parsed.port || "(default)",
      database: parsed.pathname.replace(/^\//, ""),
    };
  } catch {
    return { mode: "database-url", parseable: false };
  }
}

export function validateProductionDatabaseConfig() {
  // DATABASE_URL is validated at module load; this is a no-op kept for call-site compatibility.
}
