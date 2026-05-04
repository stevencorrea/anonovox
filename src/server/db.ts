import type { PoolConfig } from "pg";

const IS_HOT_RELOAD = Bun.argv.includes("--hot");
const IS_PRODUCTION_RUNTIME = process.env.NODE_ENV === "production" && !IS_HOT_RELOAD;

function readTrimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readPgEnvConfig(): PoolConfig | null {
  const host = readTrimmedEnv("PGHOST");
  const user = readTrimmedEnv("PGUSERNAME") ?? readTrimmedEnv("PGUSER");
  const password = process.env.PGPASSWORD ?? "";
  const database = readTrimmedEnv("PGDATABASE");
  const rawPort = readTrimmedEnv("PGPORT");

  const hasAnyPgEnv = Boolean(host || user || database || rawPort || process.env.PGPASSWORD);
  if (!hasAnyPgEnv) return null;

  const missing = [
    !host ? "PGHOST" : null,
    !user ? "PGUSERNAME or PGUSER" : null,
    !database ? "PGDATABASE" : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Incomplete PG* database configuration. Missing: ${missing.join(", ")}`);
  }

  const port = rawPort ? Number(rawPort) : 5432;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PGPORT must be a positive integer");
  }

  return {
    host: host!,
    port,
    user: user!,
    password,
    database: database!,
  };
}

export function getDatabasePoolConfig(): PoolConfig {
  const pgEnvConfig = readPgEnvConfig();

  if (IS_PRODUCTION_RUNTIME && pgEnvConfig) {
    return pgEnvConfig;
  }

  const connectionString = readTrimmedEnv("DATABASE_URL");
  if (connectionString) {
    return { connectionString };
  }

  if (pgEnvConfig) {
    return pgEnvConfig;
  }

  throw new Error(
    IS_PRODUCTION_RUNTIME
      ? "Database configuration missing. Set DATABASE_URL or PGHOST/PGUSERNAME/PGPASSWORD/PGDATABASE."
      : "DATABASE_URL is required for local development.",
  );
}

export function validateProductionDatabaseConfig() {
  if (!IS_PRODUCTION_RUNTIME) return;
  getDatabasePoolConfig();
}
