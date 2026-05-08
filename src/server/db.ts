import { SQL } from "bun";
import { Pool } from "pg";
import type { PoolConfig } from "pg";

const CONFLICTING_DATABASE_URL_ENV_VARS = [
  "POSTGRES_URL",
  "PGURL",
  "PG_URL",
  "TLS_POSTGRES_DATABASE_URL",
  "TLS_DATABASE_URL",
] as const;

const DATABASE_URL = process.env.DATABASE_URL?.trim();

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

let parsedDatabaseUrl: URL;
try {
  parsedDatabaseUrl = new URL(DATABASE_URL);
} catch {
  throw new Error(
    "DATABASE_URL must be a valid absolute Postgres URL, for example postgresql://user:password@10.33.192.3:5432/postgres",
  );
}

for (const name of CONFLICTING_DATABASE_URL_ENV_VARS) {
  delete process.env[name];
}

export function getDatabasePoolConfig(): PoolConfig {
  return { connectionString: DATABASE_URL };
}

type DbGlobals = typeof globalThis & {
  __anonovoxSql?: SQL;
  __anonovoxPgPool?: Pool;
};

const dbGlobals = globalThis as DbGlobals;

export const sql = dbGlobals.__anonovoxSql ??= new SQL(DATABASE_URL);
export const pgPool = dbGlobals.__anonovoxPgPool ??= new Pool(getDatabasePoolConfig());

export function describeDatabaseConfig(): Record<string, string | number | boolean> {
  return {
    mode: "database-url",
    protocol: parsedDatabaseUrl.protocol.replace(":", ""),
    host: parsedDatabaseUrl.hostname,
    port: parsedDatabaseUrl.port || "(default)",
    database: parsedDatabaseUrl.pathname.replace(/^\//, ""),
  };
}

export function validateProductionDatabaseConfig() {
  // DATABASE_URL is validated at module load; this is a no-op kept for call-site compatibility.
}
