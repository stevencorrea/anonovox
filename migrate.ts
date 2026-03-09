/**
 * Runs all database migrations on startup.
 *
 * Schema layout:
 *   reporting.*  – safe for dashboards and reporting jobs (no PII)
 *   private.*    – restricted; contains identity data linked to responses
 *   public.*     – Better Auth tables (user, session, account, verification)
 *
 * The `reporter` Postgres role is granted access only to the `reporting`
 * schema. Any DB credential used for dashboards/reporting jobs should be
 * assigned that role so it cannot reach `private.*` even if it tries.
 *
 * All statements are idempotent and safe to re-run on every startup.
 */
export async function runMigrations() {
  // ── Better Auth core tables (public schema) ───────────────────────────────

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

  // ── Schemas ───────────────────────────────────────────────────────────────

  await Bun.sql`CREATE SCHEMA IF NOT EXISTS reporting`;
  await Bun.sql`CREATE SCHEMA IF NOT EXISTS private`;

  // ── reporting.feedback_responses (no PII — safe for dashboards) ──────────

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS reporting.feedback_responses (
      id         TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      content    TEXT        NOT NULL,
      org_domain TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // ── private.feedback_identity (PII — restricted) ─────────────────────────

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS private.feedback_identity (
      id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      response_id TEXT        NOT NULL
                              REFERENCES reporting.feedback_responses(id)
                              ON DELETE CASCADE,
      user_id     TEXT,
      user_email  TEXT,
      ip_address  TEXT,
      user_agent  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS feedback_identity_response_id_idx
      ON private.feedback_identity (response_id)
  `;

  // ── reporter role ─────────────────────────────────────────────────────────
  // Create the role if it doesn't exist, then scope its access to reporting.* only.

  await Bun.sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reporter') THEN
        CREATE ROLE reporter NOLOGIN;
      END IF;
    END
    $$
  `;

  await Bun.sql`GRANT USAGE ON SCHEMA reporting TO reporter`;
  await Bun.sql`GRANT SELECT ON reporting.feedback_responses TO reporter`;
  await Bun.sql`REVOKE ALL ON SCHEMA private FROM reporter`;

  // ── Remove legacy table (migrated to split schema above) ─────────────────

  await Bun.sql`DROP TABLE IF EXISTS public.feedback`;

  console.log("Migrations complete.");
}
