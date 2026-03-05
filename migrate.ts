/**
 * Runs all database migrations on startup.
 *
 * Better Auth tables (user, session, account, verification) are created here
 * so the app is fully self-contained — no separate CLI migration step is needed.
 * All statements use CREATE TABLE / INDEX IF NOT EXISTS and are safe to re-run.
 */
export async function runMigrations() {
  // ── Better Auth core tables ──────────────────────────────────────────────

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS "user" (
      "id"            TEXT        PRIMARY KEY,
      "name"          TEXT        NOT NULL,
      "email"         TEXT        NOT NULL UNIQUE,
      "emailVerified" BOOLEAN     NOT NULL DEFAULT false,
      "image"         TEXT,
      "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS "session" (
      "id"          TEXT        PRIMARY KEY,
      "expiresAt"   TIMESTAMPTZ NOT NULL,
      "token"       TEXT        NOT NULL UNIQUE,
      "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "ipAddress"   TEXT,
      "userAgent"   TEXT,
      "userId"      TEXT        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId")
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS "account" (
      "id"                    TEXT        PRIMARY KEY,
      "accountId"             TEXT        NOT NULL,
      "providerId"            TEXT        NOT NULL,
      "userId"                TEXT        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "accessToken"           TEXT,
      "refreshToken"          TEXT,
      "idToken"               TEXT,
      "accessTokenExpiresAt"  TIMESTAMPTZ,
      "refreshTokenExpiresAt" TIMESTAMPTZ,
      "scope"                 TEXT,
      "password"              TEXT,
      "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId")
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS "verification" (
      "id"          TEXT        PRIMARY KEY,
      "identifier"  TEXT        NOT NULL,
      "value"       TEXT        NOT NULL,
      "expiresAt"   TIMESTAMPTZ NOT NULL,
      "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier")
  `;

  // ── App tables ───────────────────────────────────────────────────────────

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS feedback (
      id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      content     TEXT        NOT NULL,
      user_id     TEXT,
      user_email  TEXT,
      org_domain  TEXT,
      ip_address  TEXT,
      user_agent  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  console.log("Migrations complete.");
}
