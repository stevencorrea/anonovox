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

  // ── Better Auth organization plugin tables ────────────────────────────────

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS "organization" (
      "id"        TEXT        PRIMARY KEY,
      "name"      TEXT        NOT NULL,
      "slug"      TEXT        UNIQUE,
      "logo"      TEXT,
      "metadata"  TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS "member" (
      "id"             TEXT        PRIMARY KEY,
      "organizationId" TEXT        NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
      "userId"         TEXT        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "role"           TEXT        NOT NULL DEFAULT 'member',
      "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await Bun.sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "member_org_user_idx" ON "member" ("organizationId", "userId")
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS "member_userId_idx" ON "member" ("userId")
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS "invitation" (
      "id"             TEXT        PRIMARY KEY,
      "organizationId" TEXT        NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
      "email"          TEXT        NOT NULL,
      "role"           TEXT,
      "status"         TEXT        NOT NULL DEFAULT 'pending',
      "expiresAt"      TIMESTAMPTZ NOT NULL,
      "inviterId"      TEXT        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS "invitation_org_idx" ON "invitation" ("organizationId")
  `;

  await Bun.sql`
    ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "activeOrganizationId" TEXT
  `;

  // ── Dashboard tables ──────────────────────────────────────────────────────

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS reporting.org_insights (
      org_id       TEXT        PRIMARY KEY,
      content      JSONB       NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS reporting.leadership_responses (
      id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      org_id       TEXT        NOT NULL,
      content      TEXT        NOT NULL,
      period_label TEXT,
      posted_by    TEXT,
      posted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS leadership_responses_org_id_idx
      ON reporting.leadership_responses (org_id)
  `;

  await Bun.sql`GRANT SELECT ON reporting.org_insights TO reporter`;
  await Bun.sql`GRANT SELECT ON reporting.leadership_responses TO reporter`;

  // ── Structured feedback polls ────────────────────────────────────────────

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS reporting.structured_polls (
      id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      org_id      TEXT        NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
      question    TEXT        NOT NULL,
      options     JSONB       NOT NULL,
      status      TEXT        NOT NULL DEFAULT 'active',
      created_by  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at   TIMESTAMPTZ
    )
  `;

  await Bun.sql`
    CREATE UNIQUE INDEX IF NOT EXISTS structured_polls_active_org_idx
      ON reporting.structured_polls (org_id)
      WHERE status = 'active'
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS structured_polls_org_created_idx
      ON reporting.structured_polls (org_id, created_at DESC)
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS reporting.structured_poll_responses (
      id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      poll_id     TEXT        NOT NULL REFERENCES reporting.structured_polls(id) ON DELETE CASCADE,
      option_id   TEXT        NOT NULL,
      comment     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS structured_poll_responses_poll_idx
      ON reporting.structured_poll_responses (poll_id, updated_at DESC)
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS private.structured_poll_identity (
      id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      poll_id     TEXT        NOT NULL REFERENCES reporting.structured_polls(id) ON DELETE CASCADE,
      response_id TEXT        NOT NULL UNIQUE REFERENCES reporting.structured_poll_responses(id) ON DELETE CASCADE,
      user_id     TEXT        NOT NULL,
      user_email  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await Bun.sql`
    CREATE UNIQUE INDEX IF NOT EXISTS structured_poll_identity_poll_user_idx
      ON private.structured_poll_identity (poll_id, user_id)
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS structured_poll_identity_response_idx
      ON private.structured_poll_identity (response_id)
  `;

  await Bun.sql`GRANT SELECT ON reporting.structured_polls TO reporter`;
  await Bun.sql`GRANT SELECT ON reporting.structured_poll_responses TO reporter`;

  // ── Entra SSO: tenant ID on org + audit log ───────────────────────────────

  await Bun.sql`
    ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "entraTenantId" TEXT
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS private.sso_audit_log (
      id         TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      event      TEXT        NOT NULL,
      user_id    TEXT,
      org_id     TEXT,
      metadata   JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS sso_audit_log_user_id_idx ON private.sso_audit_log (user_id)
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS sso_audit_log_created_at_idx ON private.sso_audit_log (created_at DESC)
  `;

  // ── Email batch delivery tracking ─────────────────────────────────────────

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS reporting.batch_deliveries (
      id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      org_id          TEXT        NOT NULL,
      recipient_count INTEGER     NOT NULL DEFAULT 0,
      feedback_count  INTEGER     NOT NULL,
      status          TEXT        NOT NULL DEFAULT 'sent',
      error           TEXT,
      sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS batch_deliveries_org_sent_idx
      ON reporting.batch_deliveries (org_id, sent_at DESC)
  `;

  await Bun.sql`GRANT SELECT ON reporting.batch_deliveries TO reporter`;

  // ── Remove legacy table (migrated to split schema above) ─────────────────

  await Bun.sql`DROP TABLE IF EXISTS public.feedback`;

  // ── Slack integration ─────────────────────────────────────────────────────

  await Bun.sql`CREATE SCHEMA IF NOT EXISTS integration`;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS integration.slack_workspaces (
      id                 TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      org_id             TEXT        NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
      slack_workspace_id TEXT        NOT NULL UNIQUE,
      team_name          TEXT,
      access_token       TEXT        NOT NULL DEFAULT '',
      installed_by       TEXT,
      installed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await Bun.sql`
    ALTER TABLE private.feedback_identity
      ADD COLUMN IF NOT EXISTS submission_source TEXT DEFAULT 'web'
  `;

  // ── Teams integration ─────────────────────────────────────────────────────

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS integration.teams_tenants (
      id         TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      org_id     TEXT        NOT NULL UNIQUE REFERENCES "organization"(id) ON DELETE CASCADE,
      tenant_id  TEXT        NOT NULL,
      linked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await Bun.sql`
    CREATE UNIQUE INDEX IF NOT EXISTS teams_tenants_tenant_id_key
    ON integration.teams_tenants (tenant_id)
  `;

  // ── Multi-question surveys ────────────────────────────────────────────────

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS reporting.surveys (
      id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      org_id      TEXT        NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
      title       TEXT        NOT NULL,
      description TEXT,
      status      TEXT        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'active', 'closed')),
      launches_at TIMESTAMPTZ,
      closes_at   TIMESTAMPTZ,
      created_by  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at   TIMESTAMPTZ
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS surveys_org_created_idx
      ON reporting.surveys (org_id, created_at DESC)
  `;

  await Bun.sql`
    CREATE UNIQUE INDEX IF NOT EXISTS surveys_active_org_idx
      ON reporting.surveys (org_id)
      WHERE status = 'active'
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS reporting.survey_questions (
      id         TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      survey_id  TEXT        NOT NULL REFERENCES reporting.surveys(id) ON DELETE CASCADE,
      position   INTEGER     NOT NULL,
      type       TEXT        NOT NULL CHECK (type IN ('text', 'scale', 'choice')),
      prompt     TEXT        NOT NULL,
      options    JSONB,
      required   BOOLEAN     NOT NULL DEFAULT true
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS survey_questions_survey_idx
      ON reporting.survey_questions (survey_id, position)
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS reporting.survey_responses (
      id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      survey_id    TEXT        NOT NULL REFERENCES reporting.surveys(id) ON DELETE CASCADE,
      org_id       TEXT        NOT NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS survey_responses_survey_idx
      ON reporting.survey_responses (survey_id)
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS reporting.survey_answers (
      id          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      response_id TEXT NOT NULL REFERENCES reporting.survey_responses(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL REFERENCES reporting.survey_questions(id) ON DELETE CASCADE,
      value       TEXT,
      PRIMARY KEY (response_id, question_id)
    )
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS private.survey_identity (
      id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      survey_id   TEXT        NOT NULL,
      response_id TEXT        NOT NULL UNIQUE REFERENCES reporting.survey_responses(id) ON DELETE CASCADE,
      user_id     TEXT        NOT NULL,
      user_email  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await Bun.sql`
    CREATE UNIQUE INDEX IF NOT EXISTS survey_identity_survey_user_idx
      ON private.survey_identity (survey_id, user_id)
  `;

  await Bun.sql`GRANT SELECT ON reporting.surveys TO reporter`;
  await Bun.sql`GRANT SELECT ON reporting.survey_questions TO reporter`;
  await Bun.sql`GRANT SELECT ON reporting.survey_responses TO reporter`;
  await Bun.sql`GRANT SELECT ON reporting.survey_answers TO reporter`;

  // ── Insights history for trend/delta comparisons ──────────────────────────

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS reporting.insights_history (
      id             TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      org_id         TEXT        NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
      content        JSONB       NOT NULL,
      feedback_count INTEGER     NOT NULL DEFAULT 0,
      generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await Bun.sql`
    CREATE INDEX IF NOT EXISTS insights_history_org_generated_idx
      ON reporting.insights_history (org_id, generated_at DESC)
  `;

  await Bun.sql`GRANT SELECT ON reporting.insights_history TO reporter`;

  console.log("Migrations complete.");
}
