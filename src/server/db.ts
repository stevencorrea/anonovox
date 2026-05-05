import { SQL } from "bun";
import type { PoolConfig } from "pg";

const IS_HOT_RELOAD = Bun.argv.includes("--hot");
const IS_PRODUCTION_RUNTIME = process.env.NODE_ENV === "production" && !IS_HOT_RELOAD;

type ResolvedPgConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

function readTrimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function normalizeSqlHostname(host: string, port: number): string {
  if (!host.startsWith("/cloudsql/")) return host;
  const socketSuffix = `/.s.PGSQL.${port}`;
  return host.endsWith(socketSuffix) ? host : `${host}${socketSuffix}`;
}

function readPgEnvConfig(): ResolvedPgConfig | null {
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

function getSqlClientConfig(): string | { hostname: string; port: number; username: string; password: string; database: string } {
  const pgEnvConfig = readPgEnvConfig();

  if (IS_PRODUCTION_RUNTIME && pgEnvConfig) {
    return {
      hostname: normalizeSqlHostname(pgEnvConfig.host!, pgEnvConfig.port!),
      port: pgEnvConfig.port!,
      username: pgEnvConfig.user!,
      password: pgEnvConfig.password ?? "",
      database: pgEnvConfig.database!,
    };
  }

  const connectionString = readTrimmedEnv("DATABASE_URL");
  if (connectionString) {
    return connectionString;
  }

  if (pgEnvConfig) {
    return {
      hostname: normalizeSqlHostname(pgEnvConfig.host!, pgEnvConfig.port!),
      port: pgEnvConfig.port!,
      username: pgEnvConfig.user!,
      password: pgEnvConfig.password ?? "",
      database: pgEnvConfig.database!,
    };
  }

  throw new Error(
    IS_PRODUCTION_RUNTIME
      ? "Database configuration missing. Set DATABASE_URL or PGHOST/PGUSERNAME/PGPASSWORD/PGDATABASE."
      : "DATABASE_URL is required for local development.",
  );
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

const sqlClientConfig = getSqlClientConfig();
export const sql = typeof sqlClientConfig === "string"
  ? new SQL(sqlClientConfig)
  : new SQL(sqlClientConfig);

export function describeDatabaseConfig(): Record<string, string | number | boolean> {
  const pgEnvConfig = readPgEnvConfig();
  if (IS_PRODUCTION_RUNTIME && pgEnvConfig) {
    return {
      mode: "pg-env",
      host: pgEnvConfig.host,
      port: pgEnvConfig.port,
      database: pgEnvConfig.database,
      user: pgEnvConfig.user,
      cloudSqlSocket: pgEnvConfig.host.startsWith("/cloudsql/"),
    };
  }

  const connectionString = readTrimmedEnv("DATABASE_URL");
  if (connectionString) {
    try {
      const parsed = new URL(connectionString);
      return {
        mode: "database-url",
        protocol: parsed.protocol.replace(":", ""),
        host: parsed.hostname,
        port: parsed.port || "(default)",
        database: parsed.pathname.replace(/^\//, ""),
      };
    } catch {
      return {
        mode: "database-url",
        parseable: false,
      };
    }
  }

  if (pgEnvConfig) {
    return {
      mode: "pg-env",
      host: pgEnvConfig.host,
      port: pgEnvConfig.port,
      database: pgEnvConfig.database,
      user: pgEnvConfig.user,
      cloudSqlSocket: pgEnvConfig.host.startsWith("/cloudsql/"),
    };
  }

  return { mode: "missing" };
}

export function validateProductionDatabaseConfig() {
  if (!IS_PRODUCTION_RUNTIME) return;
  getDatabasePoolConfig();
}
